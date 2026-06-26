/**
 * Sync Engine — step 4 of a Push: execution and SyncLink writes.
 *
 * Steps 1–3 are deterministic and side-effect-free: {@link planPush} produces a
 * topologically ordered {@link PushPlan} of create / update / skip decisions, and
 * the preview turns it into a tree the user reviews and approves (SpecForge is
 * local-first: AI proposes, the user disposes). This module is where, after that
 * approval, the plan finally touches the world — it drives the {@link IAdapter}
 * to create/update items in the PM tool and records a {@link SyncLink} for every
 * successful write so the next push for the same item is idempotent rather than a
 * duplicate.
 *
 * ## Input is the topo-sorted plan, not the preview tree
 * {@link executePush} consumes `plan.ordered` directly — the flat,
 * parents-before-children list straight from {@link topologicalSort}. The preview
 * tree is a lossy, presentation-only projection (it flattens cycle members to
 * roots and drops ordering guarantees), so it is the wrong input here. The
 * ordering guarantee is load-bearing: because every acyclic parent is emitted
 * before its children, a single forward pass can link each freshly created child
 * to its parent's just-minted external id without a second pass.
 *
 * ## DB-free and network-free by construction (injected dependencies)
 * This module imports no runtime database code — `SyncLink` arrives as a
 * **type-only** import (erased at compile time), and the actual persistence is
 * injected as {@link PushExecutionDeps.writeLink}. The network likewise enters
 * only through the injected {@link IAdapter}. Production wires `writeLink` to the
 * real `upsertSyncLink`; tests pass an in-memory capture. This keeps the unit
 * runnable under the Vitest/jsdom environment, which cannot open SQLite, and
 * mirrors the same purity discipline as {@link planPush} and the preview builder.
 *
 * ## Partial-failure contract (no enclosing transaction)
 * Each item is pushed inside its own try/catch and the loop logs-and-continues on
 * failure (mirroring `rebuildIndex`'s per-file loop). There is deliberately **no**
 * enclosing transaction: every `writeLink` is an independent committed write, so a
 * failure midway through the plan can never corrupt or roll back the items that
 * already succeeded. A failed create/update records a `failed` result, writes no
 * link, and is left out of the external-id map — its descendants will then find no
 * parent id and report a `linkError` rather than crashing. Linking is best-effort
 * and isolated per child (a single-element {@link IAdapter.linkItems} call), so a
 * bad link never fails the sibling that links fine, and never undoes the child's
 * already-written SyncLink.
 *
 * @see ./sync-engine for the {@link PushPlan} this module consumes.
 * @see ./adapter for the provider-agnostic {@link IAdapter} contract.
 * @see ../db/repositories/sync-links.repo for the SyncLink model & `upsertSyncLink`.
 */

import type { IAdapter } from './adapter';
import type { PushPlan, SyncDecision } from './sync-engine';
import type { SyncLink } from '../db/repositories/sync-links.repo';
import { resolveLevel } from './level-mapping';

/**
 * Collaborators {@link executePush} needs, all injected so the module stays
 * DB-free and network-free (see the module docblock).
 */
export interface PushExecutionDeps {
  /** The provider adapter that performs the create/update/link calls. */
  adapter: IAdapter;
  /**
   * Persists a SyncLink on a successful create/update. Injected so the unit stays
   * DB-free (jsdom can't open SQLite). Production wires `upsertSyncLink`.
   */
  writeLink: (link: SyncLink) => void;
  /**
   * Current timestamp as ISO-8601. Injectable for deterministic tests. Defaults
   * to `() => new Date().toISOString()`.
   */
  now?: () => string;
  /**
   * OPTIONAL per-call progress callback. When supplied, {@link executePush}
   * emits an {@link ItemProgressEvent} `start` at the top of each item's turn and
   * a `done` at its terminal result, so a live UI can fill in a per-item list as
   * the push runs. It is a fire-and-forget SIDE-EFFECT sink — exactly like
   * {@link writeLink} — so the executor stays network/DB-free; it never awaits
   * the callback and a throwing callback must not abort the push (callers wrap
   * their own work). Absent → a pure no-op, identical to the original behavior.
   */
  onItemProgress?: (ev: ItemProgressEvent) => void;
}

/** Outcome of pushing a single item. */
export type ItemPushStatus = 'created' | 'updated' | 'skipped' | 'failed';

/**
 * A live per-item progress event emitted by {@link executePush} as the plan is
 * applied, so callers can drive a live "pending → creating → done/failed" list
 * instead of waiting for the whole {@link PushResult}.
 *
 * `start` fires once at the TOP of an item's turn in the loop (before any adapter
 * call); `done` fires once at its terminal result (skip/create/update/fail). The
 * pair is emitted for every item in `plan.ordered`, in order, so a `start`
 * always precedes its matching `done`. `localId` identifies the item across both
 * events; `done` additionally carries the item's final {@link ItemPushResult}.
 */
export type ItemProgressEvent =
  | { phase: 'start'; localId: string; decision: SyncDecision; title: string }
  | { phase: 'done'; localId: string; decision: SyncDecision; title: string; result: ItemPushResult };

/** Per-item result of a push, in `plan.ordered` order. */
export interface ItemPushResult {
  /** The item's SpecForge-local id (== `SyncLink.specItemId`). */
  localId: string;
  /** The decision this item carried in the plan. */
  decision: SyncDecision;
  /** What actually happened to the item. */
  status: ItemPushStatus;
  /** Provider-native id, present for `created`/`updated`. */
  externalId?: string;
  /** Deep link to the provider item, present for `created`/`updated`. */
  externalUrl?: string;
  /** true/false when a `linkItems` call was attempted for this child. */
  linked?: boolean;
  /** Reason a child could not be linked (parent unavailable or link failure). */
  linkError?: string;
  /** create/update failure message. */
  error?: string;
}

/** The full push outcome: per-item results plus tallies by status. */
export interface PushResult {
  /** Per-item results, in `plan.ordered` order. */
  results: ItemPushResult[];
  /** Count of items created. */
  created: number;
  /** Count of items updated. */
  updated: number;
  /** Count of items skipped. */
  skipped: number;
  /** Count of items whose create/update failed. */
  failed: number;
}

/**
 * Execute an approved {@link PushPlan} against a provider, writing a
 * {@link SyncLink} for every successful create/update.
 *
 * A single forward pass over `plan.ordered` (parents precede children) drives the
 * adapter and threads each freshly created/known external id forward via an
 * in-memory `localId → externalId` map so children can be linked to their
 * parent's external id. See the module docblock for the partial-failure contract
 * and why there is no enclosing transaction.
 *
 * @param plan the topologically ordered plan from {@link planPush}.
 * @param connectionId the target connection; stamped onto every written SyncLink.
 * @param deps injected adapter, link writer, and clock.
 * @returns per-item results and status tallies; always resolves (it never throws
 * on a per-item failure — those are captured as `failed` results).
 */
export async function executePush(
  plan: PushPlan,
  connectionId: string,
  deps: PushExecutionDeps,
): Promise<PushResult> {
  const { adapter, writeLink } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const onItemProgress = deps.onItemProgress;

  // Resolved external ids keyed by SpecForge-local id, populated as we go.
  // Because parents precede children in `plan.ordered`, a parent's external id is
  // always present (when the parent succeeded) by the time its children are seen.
  const externalIdByLocalId = new Map<string, string>();

  // Owning-container external id keyed by SpecForge-local id (e.g. the Linear
  // Project an Epic maps to). A container item owns itself; any other item
  // inherits its parent's owner, so the owner flows down the whole subtree.
  // Children of a container join it via `projectId` at create rather than a
  // native parent link — see the `create` branch's link-skip guard below.
  const ownerProjectByLocalId = new Map<string, string>();
  const results: ItemPushResult[] = [];

  for (const diff of plan.ordered) {
    const { item, decision } = diff;
    const localId = item.localId;

    // One place that BOTH records the terminal result AND emits its `done`
    // progress event, so every result site (skip/create/update/fail/catch) is
    // covered without a per-site emit that could be forgotten. Returns `void` so
    // it reads as a statement at each call site.
    const record = (r: ItemPushResult): void => {
      results.push(r);
      onItemProgress?.({ phase: 'done', localId, decision, title: item.title, result: r });
    };

    // `start` fires at the TOP of the turn, before any adapter call, so a live
    // UI can flip the row to "creating…" the moment its work begins.
    onItemProgress?.({ phase: 'start', localId, decision, title: item.title });

    // Whether children of this item join it as members of a provider container
    // (e.g. Linear project membership) rather than being parent-linked to it, and
    // the container the parent already belongs to (so it flows to this item).
    const isContainer = resolveLevel(adapter.name, item.level).containerForChildren === true;
    const parentOwner = item.parentLocalId !== undefined
      ? ownerProjectByLocalId.get(item.parentLocalId)
      : undefined;

    try {
      if (decision === 'skip') {
        // No adapter call and no write. Still seed the map so a child of this
        // already-existing item can link to its known external id.
        if (diff.link?.externalId) {
          externalIdByLocalId.set(localId, diff.link.externalId);
        }
        // Record the owning container so descendants still resolve their project:
        // a skipped container owns itself (via its existing link), otherwise it
        // carries the parent's owner forward.
        const owner = isContainer ? diff.link?.externalId : parentOwner;
        if (owner !== undefined) ownerProjectByLocalId.set(localId, owner);
        record({ localId, decision, status: 'skipped' });
        continue;
      }

      if (decision === 'create') {
        // The item joins the owner the engine resolved from its nearest container
        // ancestor (e.g. its Epic's Linear project) at create time.
        const res = await adapter.createItem(item, { projectExternalId: parentOwner });
        writeLink({
          specItemId: localId,
          connectionId,
          externalId: res.externalId,
          externalUrl: res.externalUrl,
          lastPushedHash: diff.hash,
          lastPushedAt: now(),
        });
        externalIdByLocalId.set(localId, res.externalId);

        // A container owns itself (its just-minted external id); otherwise it
        // inherits the parent's owner. Recorded so descendants resolve their owner.
        const owner = isContainer ? res.externalId : parentOwner;
        if (owner !== undefined) ownerProjectByLocalId.set(localId, owner);

        const result: ItemPushResult = {
          localId,
          decision,
          status: 'created',
          externalId: res.externalId,
          externalUrl: res.externalUrl,
        };

        // Linking is only attempted for items just created (an update/skip child
        // keeps its existing parent link; full re-parenting is out of scope).
        if (item.parentLocalId !== undefined) {
          const parentExternalId = externalIdByLocalId.get(item.parentLocalId);
          if (parentExternalId === undefined) {
            // Parent failed or is a cyclic node not yet processed: the child's own
            // create already succeeded, so we leave it intact and flag the link.
            result.linked = false;
            result.linkError = 'parent external id unavailable';
          } else if (owner !== undefined && parentExternalId === owner) {
            // The parent IS the container this child already joined via `projectId`
            // at create (e.g. an Epic's Linear project). A native parent link to it
            // would be invalid, so membership stands in for the link: mark linked
            // with no error and skip the linkItems call.
            result.linked = true;
          } else {
            // Single-element link per child so one bad link can't fail siblings,
            // and isolate it so a link failure never marks the item `failed` nor
            // undoes the already-written SyncLink.
            try {
              await adapter.linkItems(parentExternalId, [res.externalId]);
              result.linked = true;
            } catch (linkErr) {
              console.error('[sync] failed to link item to parent', localId, linkErr);
              result.linked = false;
              result.linkError =
                linkErr instanceof Error ? linkErr.message : String(linkErr);
            }
          }
        }

        record(result);
        continue;
      }

      // decision === 'update'
      const existingLink = diff.link;
      if (!existingLink?.externalId) {
        // A diff marked `update` always carries the existing link with its external
        // id; a missing link or empty id is a data error. Record it and continue
        // rather than calling the adapter with no id. Narrowing on `existingLink`
        // (not just its id) also lets us reuse `externalUrl` below without a
        // non-null assertion.
        record({
          localId,
          decision,
          status: 'failed',
          error: 'update decision is missing its SyncLink external id',
        });
        continue;
      }

      const { externalId, externalUrl } = existingLink;
      await adapter.updateItem(externalId, item);
      writeLink({
        specItemId: localId,
        connectionId,
        externalId,
        externalUrl,
        lastPushedHash: diff.hash,
        lastPushedAt: now(),
      });
      externalIdByLocalId.set(localId, externalId);

      // Record the owning container (no linking happens in this branch): a
      // container owns itself via its external id, otherwise it carries the
      // parent's owner forward so descendants still resolve their project.
      const owner = isContainer ? externalId : parentOwner;
      if (owner !== undefined) ownerProjectByLocalId.set(localId, owner);

      record({
        localId,
        decision,
        status: 'updated',
        externalId,
        externalUrl,
      });
    } catch (err) {
      // Create/update failure: log and continue so one bad item never aborts the
      // push. No link is written and the item is left out of the external-id map,
      // so its descendants will report `parent external id unavailable`.
      console.error('[sync] failed to push item', localId, err);
      record({
        localId,
        decision,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    results,
    created: results.filter((r) => r.status === 'created').length,
    updated: results.filter((r) => r.status === 'updated').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };
}
