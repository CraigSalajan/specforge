/**
 * Sync Engine — steps 1–2 of a Push: topological ordering and content diffing.
 *
 * A Push takes a set of provider-agnostic {@link CanonicalItem}s and pushes them
 * to a PM tool (Jira / ADO / Linear / GitHub). Before anything touches the
 * network we must answer two questions deterministically:
 *
 *   1. **In what order?** — Parents must be created before children so the
 *      adapter can link a child to a parent's freshly minted external id. The
 *      canonical tree is flat (each item points at its parent via
 *      `parentLocalId`), so we derive a parent→child DAG and topologically sort
 *      it with Kahn's algorithm ({@link topologicalSort}).
 *   2. **Create, update, or skip?** — Each item is hashed over its content-bearing
 *      fields and compared against the `lastPushedHash` recorded on its
 *      {@link SyncLink}. No link ⇒ create; hash changed ⇒ update; hash equal ⇒
 *      skip ({@link diffItem}). This is the same "changed since last push"
 *      detection the SyncLink model was built for.
 *
 * The output of {@link planPush} is a {@link PushPlan} — the ordered list of
 * per-item decisions — which feeds the TER-12 push preview (the user reviews and
 * approves before anything is written; AI proposes, user disposes).
 *
 * ## Why this module is DB-free
 * Nothing here calls `getDb()`. Resolving an item's SyncLink is injected by the
 * caller as a {@link SyncLinkResolver}. In production the caller builds that
 * resolver once per connection from `listSyncLinksForConnection(connectionId)`
 * (a single query → a `Map<specItemId, SyncLink>` lookup) so a plan over N items
 * costs one query, not N. Keeping the engine pure also lets it run under the
 * Vitest (jsdom) test environment, which cannot open SQLite.
 *
 * ## Hashing scheme
 * {@link serializeItemForHash} emits a canonical JSON string of the
 * content-bearing fields in a FIXED key order (`level, title, description,
 * criteria, tags, parentLocalId`), omitting any `undefined` field so the output
 * is stable across runs. `localId` is identity, not content, and is excluded —
 * two items with identical content but different ids hash equal. `criteria` and
 * `tags` are left in their given order: a reorder is a genuine content change, so
 * we must not sort them.
 *
 * ## Cycle & dangling-parent decisions
 * - A `parentLocalId` that does not resolve to an item in the input is treated as
 *   a **root** (indegree 0): we never drop the item, and a child orphaned by a
 *   partial selection still gets pushed.
 * - The sort is **cycle-safe**: it never infinite-loops. Any nodes left
 *   unemitted after Kahn completes are part of (or downstream of) a cycle; they
 *   are appended to `ordered` in original input order and reported in `cycles` as
 *   a single group of their `localId`s (see {@link topologicalSort}).
 *
 * @see ./canonical-item for the item model.
 * @see ../db/repositories/sync-links.repo for the SyncLink model & per-connection list.
 * @see ../util/hash for the sha256 helper.
 */

import type { CanonicalItem } from './canonical-item';
import type { SyncLink } from '../db/repositories/sync-links.repo';
import { sha256 } from '../util/hash';

/** What a Push should do with a single item, derived from its SyncLink state. */
export type SyncDecision = 'create' | 'update' | 'skip';

/** A single item's place in the plan: its decision and freshly computed hash. */
export interface ItemDiff {
  /** The canonical item this diff describes. */
  item: CanonicalItem;
  /** What the Push should do with the item. */
  decision: SyncDecision;
  /** Content hash freshly computed for `item` (see {@link computeItemHash}). */
  hash: string;
  /** The existing link, present for `update`/`skip`; absent for `create`. */
  link?: SyncLink;
}

/** The full ordered plan plus any cycles detected while ordering. */
export interface PushPlan {
  /** Per-item decisions, parents before children (cyclic nodes last). */
  ordered: ItemDiff[];
  /**
   * Groups of `localId`s involved in a dependency cycle (empty when the input is
   * a DAG). Currently a single group of all unemitted nodes — see
   * {@link topologicalSort}.
   */
  cycles: string[][];
}

/**
 * Resolves the SyncLink for a given `specItemId` (an item's `localId`), or
 * `null`/`undefined` when the item has never been pushed on this connection.
 * Injected by the caller so the engine stays DB-free — build it from a
 * `Map<specItemId, SyncLink>` seeded by `listSyncLinksForConnection`.
 */
export type SyncLinkResolver = (specItemId: string) => SyncLink | null | undefined;

/**
 * Deterministic, canonical serialization of an item's **content-bearing** fields
 * for hashing. Keys are emitted in the fixed order `level, title, description,
 * criteria, tags, parentLocalId`; any field whose value is `undefined` is
 * omitted so `JSON.stringify` output is stable. `localId` is deliberately
 * excluded — it is identity, not content. `criteria`/`tags` arrays keep their
 * given order (a reorder is a real content change), so they are NOT sorted.
 */
export function serializeItemForHash(item: CanonicalItem): string {
  // Insertion order of an object literal's string keys is preserved by
  // JSON.stringify, so building the object in this exact order gives a stable
  // serialization. Only assign defined fields to keep `undefined` out.
  const canonical: Record<string, unknown> = { level: item.level, title: item.title };
  if (item.description !== undefined) canonical['description'] = item.description;
  if (item.criteria !== undefined) canonical['criteria'] = item.criteria;
  if (item.tags !== undefined) canonical['tags'] = item.tags;
  if (item.parentLocalId !== undefined) canonical['parentLocalId'] = item.parentLocalId;
  return JSON.stringify(canonical);
}

/** SHA-256 hex digest of an item's canonical content serialization. */
export function computeItemHash(item: CanonicalItem): string {
  return sha256(serializeItemForHash(item));
}

/**
 * Topologically sort canonical items so parents precede children.
 *
 * Implementation: Kahn's algorithm over the parent→child DAG derived from
 * `parentLocalId`.
 *
 * - **Edges.** An item contributes a parent→child edge only when its
 *   `parentLocalId` is set AND resolves to another item in the input. A dangling
 *   `parentLocalId` (parent not in the input) is treated as a root: the item
 *   keeps indegree 0 and is still emitted.
 * - **Stability.** Among items that are currently free (no remaining
 *   dependency), original input order is preserved. We seed the ready queue by
 *   scanning `items` in order, and when a parent is emitted we append its
 *   now-free children in input order. Independent items therefore come out in
 *   exactly their input order.
 * - **Cycle-safety.** The algorithm never loops forever. After Kahn drains, any
 *   nodes still unemitted are part of (or downstream of) a cycle. We append them
 *   to `ordered` in original input order so callers always receive every item,
 *   and report them via `cycles`. For simplicity and determinism `cycles` is a
 *   single group containing every unemitted `localId` in input order (rather
 *   than decomposing into individual strongly-connected components); this is
 *   sufficient for the push preview, which only needs to surface "these items
 *   form a cycle and were not safely ordered".
 * - **Duplicate ids.** If two items share a `localId`, the map keeps the last
 *   one (last-wins); we never crash on duplicates.
 */
export function topologicalSort(items: CanonicalItem[]): {
  ordered: CanonicalItem[];
  cycles: string[][];
} {
  // Identity map; last-wins on duplicate localIds.
  const byId = new Map<string, CanonicalItem>();
  for (const item of items) byId.set(item.localId, item);

  // Indegree per item and children adjacency, both keyed by localId.
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (!indegree.has(item.localId)) indegree.set(item.localId, 0);
  }
  for (const item of items) {
    const parentId = item.parentLocalId;
    // Edge only counts when the parent is set and present in the input;
    // a dangling parent leaves the child as a root (indegree 0).
    if (parentId !== undefined && byId.has(parentId) && parentId !== item.localId) {
      const siblings = children.get(parentId);
      if (siblings) siblings.push(item.localId);
      else children.set(parentId, [item.localId]);
      indegree.set(item.localId, (indegree.get(item.localId) ?? 0) + 1);
    }
  }

  // Seed the ready queue with free nodes in input order so the output is stable.
  const queue: string[] = [];
  for (const item of items) {
    if ((indegree.get(item.localId) ?? 0) === 0) queue.push(item.localId);
  }

  const ordered: CanonicalItem[] = [];
  const emitted = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (emitted.has(id)) continue; // guards duplicate enqueue from duplicate ids
    const item = byId.get(id);
    if (!item) continue;
    ordered.push(item);
    emitted.add(id);
    // Children are stored in input order, so they free up in input order.
    for (const childId of children.get(id) ?? []) {
      const remaining = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, remaining);
      if (remaining === 0) queue.push(childId);
    }
  }

  // Anything not emitted is in (or downstream of) a cycle. Append in input order
  // so callers always get every item, and report the offending ids.
  const unemitted: string[] = [];
  for (const item of items) {
    if (!emitted.has(item.localId)) {
      ordered.push(item);
      emitted.add(item.localId);
      unemitted.push(item.localId);
    }
  }
  const cycles: string[][] = unemitted.length > 0 ? [unemitted] : [];

  return { ordered, cycles };
}

/**
 * Decide what a Push should do with a single item by comparing its freshly
 * computed content hash against the hash recorded at last push.
 *
 * - no link            → `create`
 * - link, hash changed  → `update`
 * - link, hash equal    → `skip`
 */
export function diffItem(item: CanonicalItem, link: SyncLink | null | undefined): ItemDiff {
  const hash = computeItemHash(item);
  if (!link) return { item, decision: 'create', hash };
  if (link.lastPushedHash !== hash) return { item, decision: 'update', hash, link };
  return { item, decision: 'skip', hash, link };
}

/**
 * Build the full push plan: topologically order the items (parents first), then
 * diff each ordered item against its resolved SyncLink. The resulting
 * {@link PushPlan} carries the per-item create/update/skip decisions plus any
 * detected cycles, ready for the TER-12 preview.
 *
 * `resolveLink` is invoked once per item with the item's `localId`
 * (== `SyncLink.specItemId`); inject a map-backed resolver to avoid N+1 queries.
 */
export function planPush(items: CanonicalItem[], resolveLink: SyncLinkResolver): PushPlan {
  const { ordered, cycles } = topologicalSort(items);
  return {
    ordered: ordered.map((item) => diffItem(item, resolveLink(item.localId))),
    cycles,
  };
}
