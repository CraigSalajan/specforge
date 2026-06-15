/**
 * Sync Engine — step 3 of a Push: preview-tree generation.
 *
 * The Sync Engine produces a {@link PushPlan} (TER-11): a flat, topologically
 * ordered list of per-item {@link ItemDiff} decisions plus any detected
 * `cycles`. Before anything touches the network the user must review and approve
 * what will happen — SpecForge is local-first: AI proposes, the user disposes.
 *
 * This module turns that flat plan into a **hierarchical, read-only preview
 * tree** ({@link PushPreviewTree}) the UI can render for confirmation. It answers
 * "what will this Push do, and to what?" — for every item: its create / update /
 * skip decision, how the target provider will represent it (native work-item type
 * or an inline fold into the parent), a presence-based content summary, and the
 * existing external link for items that already exist remotely.
 *
 * ## Purity contract
 * {@link buildPushPreview} is **pure and read-only**. It does not mutate the
 * input {@link PushPlan}, its {@link ItemDiff}s, or the underlying
 * {@link CanonicalItem}s; it never touches the database, the network, or any
 * shared state. Every {@link PreviewNode} is freshly allocated, so the original
 * canonical items never gain a stray `children` array. This keeps the function
 * trivially testable (it runs under the Vitest/jsdom environment, which cannot
 * open SQLite) and safe to call repeatedly while the user revises a selection.
 *
 * ## Why no field-level before/after diff
 * The data model records only `lastPushedHash` on a {@link SyncLink} — the hash
 * of the content at last push, never the prior content itself. A genuine
 * field-by-field "before vs after" diff is therefore impossible here and out of
 * scope. The preview instead surfaces a presence-based
 * {@link PreviewChangeSummary} (has a description? how many criteria / tags?),
 * which is enough for the user to gauge the shape of each item being pushed.
 *
 * ## Tree construction (single forward pass)
 * `plan.ordered` is already **parents-before-children** for every acyclic node
 * (that is the guarantee `topologicalSort` provides), so a parent's
 * {@link PreviewNode} is always registered before any of its children are
 * visited. A single forward pass that attaches each node to its
 * already-registered parent therefore reconstructs the full hierarchy without a
 * second pass or any recursion.
 *
 * Nodes in (or downstream of) a cycle are surfaced as **flagged roots**
 * (`inCycle: true`) rather than nested. The engine cannot give them a safe
 * parents-first position, and nesting a cycle would risk an infinite/ill-defined
 * structure — so we keep the output a finite, acyclic tree and pass `plan.cycles`
 * straight through for the UI to warn on. This mirrors the exact root predicate
 * `topologicalSort` uses (root iff `parentLocalId` is unset, self-referential, or
 * dangling) with one extra guard: a cycle member is always a root.
 *
 * @see ./sync-engine for the {@link PushPlan} this module consumes.
 * @see ./level-mapping for how a provider represents each {@link CanonicalLevel}.
 * @see ./canonical-item for the item model.
 * @see ../db/repositories/sync-links.repo for the {@link SyncLink} model.
 */

import type { AdapterName } from './adapter';
import type { CanonicalLevel } from './canonical-item';
import type { ItemDiff, PushPlan, SyncDecision } from './sync-engine';
import { type LevelRepresentation, resolveLevel } from './level-mapping';

/**
 * Presence-based summary of an item's content for the preview.
 *
 * There is intentionally NO field-level before/after diff: the data model stores
 * only `lastPushedHash` (the hash at last push, not the prior content), so a true
 * field diff is impossible here and out of scope (see the module docblock). These
 * flags/counts let the UI convey the shape of each item without that history.
 */
export interface PreviewChangeSummary {
  /** Whether the item carries a long-form description. */
  hasDescription: boolean;
  /** Number of acceptance criteria on the item (0 when absent). */
  criteriaCount: number;
  /** Number of free-form tags/labels on the item (0 when absent). */
  tagCount: number;
}

/**
 * One node in the hierarchical push preview: a single {@link CanonicalItem}'s
 * planned outcome, plus how the target provider will represent it and where it
 * sits in the tree.
 */
export interface PreviewNode {
  /** SpecForge-local identifier of the item (== {@link CanonicalItem.localId}). */
  localId: string;
  /** The item's level in the spec hierarchy. */
  level: CanonicalLevel;
  /** What the Push will do with this item (reused from the Sync Engine). */
  decision: SyncDecision;
  /**
   * Target provider for this Push. The same across the whole tree, but surfaced
   * per node so the UI can label each row independently (per the acceptance
   * criteria).
   */
  provider: AdapterName;
  /**
   * Provider-native work-item type for this level (e.g. Linear 'Project' for an
   * epic), from {@link resolveLevel}.
   */
  nativeType: string;
  /**
   * How the provider represents this level: `'item'` (its own native work item)
   * or `'inline'` (folded into its parent on this provider, e.g. acceptance
   * criteria rendered into a Linear description). From {@link resolveLevel}.
   */
  representation: LevelRepresentation;
  /** Short human-readable title/summary of the item. */
  title: string;
  /** Presence-based summary of the item's content. */
  summary: PreviewChangeSummary;
  /**
   * Provider-native id of the existing remote item, from the item's
   * {@link SyncLink}; present for `update`/`skip`, absent for `create`.
   */
  externalId?: string;
  /** Deep link to the existing remote item, from the item's {@link SyncLink}. */
  externalUrl?: string;
  /**
   * `true` when the item is in (or downstream of) a dependency cycle. Such nodes
   * are surfaced as flagged roots rather than nested (see the module docblock).
   */
  inCycle: boolean;
  /** Child nodes in topological (parents-first) order. */
  children: PreviewNode[];
}

/** Roll-up of decisions across every node in the preview. */
export interface PreviewCounts {
  /** Items that will be created (no existing link). */
  create: number;
  /** Items whose content changed since the last push. */
  update: number;
  /** Unchanged items that will be skipped. */
  skip: number;
  /** Total items in the plan (== `create + update + skip == plan.ordered.length`). */
  total: number;
}

/** The complete read-only preview the UI renders for user confirmation. */
export interface PushPreviewTree {
  /** Top-level nodes (roots + any cycle members), in topological order. */
  roots: PreviewNode[];
  /** Decision roll-up across the whole plan. */
  counts: PreviewCounts;
  /**
   * Dependency cycles passed through verbatim from the {@link PushPlan} so the UI
   * can warn that these items were not safely ordered; `[]` for a DAG.
   */
  cycles: string[][];
}

/**
 * Build the hierarchical, read-only push preview from a {@link PushPlan}.
 *
 * Pure: the input `plan`, its diffs, and the underlying canonical items are never
 * mutated — every node is freshly allocated. Safe to call repeatedly.
 *
 * Algorithm (single forward pass; see the module docblock for the rationale):
 *  1. Flatten `plan.cycles` into a set of cyclic `localId`s.
 *  2. Walk `plan.ordered` in order. For each diff, build a {@link PreviewNode}
 *     (decision, provider-native representation via {@link resolveLevel}, content
 *     summary, external link when present, `inCycle` flag) and register it by id.
 *  3. Attach the node under its parent **iff** the parent is set, not self,
 *     already registered, and the node is not a cycle member; otherwise it is a
 *     root. (`plan.ordered` being parents-first guarantees the parent is already
 *     registered for every acyclic node.)
 *  4. Tally `counts` over every node and pass `plan.cycles` through unchanged.
 *
 * @param plan     The TER-11 push plan (ordered diffs + detected cycles).
 * @param provider The target PM provider, used to resolve native representation.
 * @returns A finite, acyclic {@link PushPreviewTree} for the UI to render.
 */
export function buildPushPreview(plan: PushPlan, provider: AdapterName): PushPreviewTree {
  // Every localId in (or downstream of) a cycle; empty for a DAG.
  const cycleIds = new Set<string>(plan.cycles.flat());

  // Registry of nodes by localId so children can find their already-built parent,
  // plus the accumulating top-level roots.
  const byId = new Map<string, PreviewNode>();
  const roots: PreviewNode[] = [];

  const counts: PreviewCounts = { create: 0, update: 0, skip: 0, total: 0 };

  for (const diff of plan.ordered) {
    const { item, decision, link } = diff;
    const native = resolveLevel(provider, item.level);

    const node: PreviewNode = {
      localId: item.localId,
      level: item.level,
      decision,
      provider,
      nativeType: native.nativeType,
      representation: native.representation,
      title: item.title,
      summary: {
        hasDescription: item.description !== undefined,
        criteriaCount: item.criteria?.length ?? 0,
        tagCount: item.tags?.length ?? 0,
      },
      inCycle: cycleIds.has(item.localId),
      children: [],
      // `externalId`/`externalUrl` are added below only when a link exists, so a
      // `create` node simply omits the keys (leaving them `undefined`).
      ...linkFields(diff),
    };

    byId.set(node.localId, node);

    // Same root predicate as `topologicalSort` (unset / self / dangling parent),
    // with the extra guard that cycle members are always flagged roots — this
    // keeps the tree finite and acyclic.
    const parentId = item.parentLocalId;
    const parent =
      parentId !== undefined && parentId !== node.localId ? byId.get(parentId) : undefined;
    if (parent && !node.inCycle) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }

    counts[decision] += 1;
    counts.total += 1;
  }

  return { roots, counts, cycles: plan.cycles };
}

/**
 * Pluck the external-link fields off a diff for spreading onto a
 * {@link PreviewNode}. Returns an empty object (no keys) when the diff has no
 * link — i.e. a `create` — so the node's optional fields stay absent rather than
 * being set to an explicit `undefined`.
 */
function linkFields(diff: ItemDiff): { externalId?: string; externalUrl?: string } {
  if (!diff.link) return {};
  return { externalId: diff.link.externalId, externalUrl: diff.link.externalUrl };
}
