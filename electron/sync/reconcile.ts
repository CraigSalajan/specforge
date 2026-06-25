/**
 * Sync Engine — pull/reconcile core (TER-23, bi-directional sync).
 *
 * The push half of sync (`./sync-engine` → `./executor`) drives SpecForge's
 * local plan *out* to a PM tool. This module is the **pull** half: given the
 * remote state of a previously-synced item (read back via
 * {@link IAdapter.getRemoteState}) it decides, deterministically and without ever
 * touching the network or the DB, whether the remote changed since SpecForge last
 * touched it, whether the local item also changed, and what the safe
 * reconciliation policy is. Just like {@link planPush}, the output is a read-only
 * plan ({@link ReconcilePlan}) the user reviews before anything is applied
 * (SpecForge is local-first: AI proposes, the user disposes).
 *
 * ## Why a hash *and* a timestamp
 * The data model gives us two signals about the remote item:
 *
 *   1. `remote.updatedAt` — Linear's `DateTime`, which bumps on *any* mutation,
 *      including metadata-only churn (a status nudge, a label change) that doesn't
 *      alter the fields SpecForge mirrors. A timestamp alone therefore over-reports
 *      change.
 *   2. {@link computeRemoteHash} — a stable hash of the *content-bearing* remote
 *      projection (`title` + optional `description`). Comparing it to the hash we
 *      stored at the last pull ({@link SyncLink.lastPulledHash}) lets us suppress
 *      those metadata-only `updatedAt` bumps: if the content hash is identical, the
 *      item didn't really change for our purposes.
 *
 * So classification leans on the **timestamp** to detect "something happened
 * remotely since our baseline" and on the **hash** to *demote* a bump that turns
 * out to be content-identical. The remote hash is deliberately NOT comparable to
 * the push-side `lastPushedHash` (which hashes the full canonical item — level,
 * criteria, tags, parent — see {@link serializeItemForHash}). The two hash
 * different field sets, so they can never be equal even for the "same" item; that
 * asymmetry is exactly why the timestamp, not a local↔remote hash compare, is the
 * primary change signal on the remote side.
 *
 * ## Classification matrix
 * Let `remoteChanged` = remote.updatedAt is strictly after the pull baseline
 * (refined to `false` when the remote content hash equals `lastPulledHash`), and
 * `localChanged` = the local content hash differs from `lastPushedHash` (only
 * knowable when `localHash` is provided — see "unknown local" below):
 *
 * | remoteChanged | localChanged | localKnown | classification  | resolution    |
 * |---------------|--------------|------------|-----------------|---------------|
 * | false         | false        | —          | `unchanged`     | `none`        |
 * | true          | false        | true       | `remote-only`   | `adopt-remote`|
 * | true          | true         | true       | `conflict`      | `needs-user`  |
 * | true          | —            | false      | `conflict`      | `needs-user`  |
 * | false         | true         | true       | `local-only`    | `keep-local`  |
 *
 * Plus: `remote === null` ⇒ `remote-missing` / `needs-user` (we never auto-delete
 * a local item just because its remote vanished).
 *
 * ## The "unknown local ⇒ conflict" safety rule
 * Extracting a local item's current content into a hash is the (deferred)
 * orchestration layer's job, so callers may pass `localHash: null` meaning "local
 * state unknown". When the remote changed but we *cannot prove the local item is
 * unchanged*, we must never silently overwrite it: an unknown-local + remote-changed
 * case is classified `conflict` (`needs-user`), not `remote-only`. Auto-adopt is
 * reserved for the case where we positively know the local item did not change.
 *
 * ## Purity & DB-/network-freedom
 * Nothing here calls `getDb()` or the network. {@link SyncLink} and
 * {@link RemoteItemState} are **type-only** imports (erased at compile time);
 * remote reads happen in the caller. The apply path persists through an injected
 * {@link ReconcileApplyDeps.writePullState} (production wires
 * `updateSyncLinkPullState`), mirroring {@link executePush}'s injected-deps
 * discipline so the unit runs under the Vitest/jsdom environment, which cannot
 * open SQLite.
 *
 * @see ./sync-engine for the push-side hashing this mirrors.
 * @see ./executor for the injected-deps apply pattern this mirrors.
 * @see ./adapter for {@link IAdapter.getRemoteState} and {@link RemoteItemState}.
 * @see ../db/repositories/sync-links.repo for the SyncLink model & `updateSyncLinkPullState`.
 * @see ../util/hash for the sha256 helper.
 */

import type { RemoteItemState } from './adapter';
import type { SyncLink } from '../db/repositories/sync-links.repo';
import { sha256 } from '../util/hash';

/** How the reconcile engine categorizes one item's local-vs-remote drift. */
export type ReconcileClassification =
  | 'unchanged'
  | 'remote-only'
  | 'local-only'
  | 'conflict'
  | 'remote-missing';

/**
 * The reconcile engine's proposed policy for an item. `none` (nothing to do),
 * `adopt-remote` (pull the remote change into local), `keep-local` (the local
 * edit wins; a later push reconciles the remote), or `needs-user` (a human must
 * decide — conflicts and a vanished remote).
 */
export type ReconcileResolution = 'none' | 'adopt-remote' | 'keep-local' | 'needs-user';

/**
 * One unit of input to {@link buildReconcilePlan}: an existing link, the remote
 * state read back for it (or `null` when the remote no longer exists), and the
 * current local content hash (or `null` when local state is unknown — extraction
 * is deferred to the orchestration layer).
 */
export interface ReconcileInput {
  /** The existing SyncLink whose remote we reconciled. */
  link: SyncLink;
  /** The remote state read back; `null` means the remote item no longer exists. */
  remote: RemoteItemState | null;
  /**
   * The current local content hash (== `lastPushedHash` when unchanged), or
   * `null` when local item state is unknown (local extraction is deferred and out
   * of scope for this core).
   */
  localHash: string | null;
}

/** The reconcile engine's per-item decision and the signals behind it. */
export interface ReconcileEntry {
  /** SpecForge-local id of the item (== {@link SyncLink.specItemId}). */
  specItemId: string;
  /** The target connection (== {@link SyncLink.connectionId}). */
  connectionId: string;
  /** Provider-native id of the remote item (from the link). */
  externalId: string;
  /** Deep link to the remote item (from the link). */
  externalUrl: string;
  /** How this item's drift was categorized. */
  classification: ReconcileClassification;
  /** The proposed policy for the user to confirm. */
  proposedResolution: ReconcileResolution;
  /** The remote's `updatedAt`, present when the remote still exists. */
  remoteUpdatedAt?: string;
  /**
   * The timestamp the remote's `updatedAt` was compared against — the pull
   * baseline (`externalUpdatedAt` if present, else `lastPushedAt`).
   */
  baselineAt: string;
  /** Whether the remote changed since the baseline (after hash demotion). */
  remoteChanged: boolean;
  /** Whether the local item changed since last push (only meaningful when `localKnown`). */
  localChanged: boolean;
  /** Whether the caller supplied a local hash (so `localChanged` is trustworthy). */
  localKnown: boolean;
}

/** The full reconcile plan: per-item entries plus roll-up counts. */
export interface ReconcilePlan {
  /** Per-input decisions, in the same order as the inputs (deterministic). */
  entries: ReconcileEntry[];
  /** Roll-up by classification. */
  counts: {
    unchanged: number;
    remoteOnly: number;
    localOnly: number;
    conflict: number;
    remoteMissing: number;
    total: number;
  };
}

/**
 * Stable, canonical hash of the **content-bearing remote projection** — the
 * `title` and (when present) `description`, in that fixed key order, omitting
 * `description` when undefined. Mirrors {@link serializeItemForHash}'s
 * fixed-key-order / omit-undefined discipline so the output is stable across runs.
 *
 * This is a *remote-projection* hash used solely to suppress metadata-only
 * `updatedAt` bumps (compare it against {@link SyncLink.lastPulledHash}). It is
 * NOT comparable to the push-side `lastPushedHash`, which hashes the full
 * canonical item (level, criteria, tags, parent) — the two hash different field
 * sets and can never be equal. That asymmetry is precisely why classification
 * leans on the timestamp for change detection and uses this hash only to demote a
 * content-identical bump (see the module docblock).
 */
export function computeRemoteHash(remote: RemoteItemState): string {
  // Insertion order of an object literal's string keys is preserved by
  // JSON.stringify; build in this exact order and only assign defined fields so
  // an absent description never differs from an explicit `undefined`.
  const canonical: Record<string, unknown> = { title: remote.title };
  if (remote.description !== undefined) canonical['description'] = remote.description;
  return sha256(JSON.stringify(canonical));
}

/**
 * Build the reconcile plan: classify each {@link ReconcileInput} and tally the
 * results. Pure and deterministic — input order is preserved and nothing here
 * touches the network or the DB.
 *
 * Per input (see the module docblock for the full matrix and rationale):
 *  - `remote === null` ⇒ `remote-missing` / `needs-user` (never auto-delete a
 *    local item whose remote vanished). `remoteChanged`/`localChanged` are still
 *    computed for surfacing, and `baselineAt` is the pull baseline.
 *  - Otherwise compute `baseline = link.externalUpdatedAt ?? link.lastPushedAt`,
 *    then `remoteChanged = remote.updatedAt is strictly after baseline`, demoted
 *    to `false` when a stored `lastPulledHash` equals the remote content hash
 *    (a content-identical `updatedAt` bump).
 *  - `localKnown = localHash !== null`; `localChanged = localKnown && localHash
 *    !== link.lastPushedHash`.
 *  - Classify via the matrix, with the safety rule that remote-changed + unknown
 *    local is a `conflict` (we can't prove local is safe to overwrite).
 */
export function buildReconcilePlan(inputs: ReconcileInput[]): ReconcilePlan {
  const entries: ReconcileEntry[] = inputs.map((input) => classify(input));

  const counts = {
    unchanged: 0,
    remoteOnly: 0,
    localOnly: 0,
    conflict: 0,
    remoteMissing: 0,
    total: entries.length,
  };
  for (const entry of entries) {
    switch (entry.classification) {
      case 'unchanged':
        counts.unchanged += 1;
        break;
      case 'remote-only':
        counts.remoteOnly += 1;
        break;
      case 'local-only':
        counts.localOnly += 1;
        break;
      case 'conflict':
        counts.conflict += 1;
        break;
      case 'remote-missing':
        counts.remoteMissing += 1;
        break;
    }
  }

  return { entries, counts };
}

/** Classify a single reconcile input into a {@link ReconcileEntry}. */
function classify(input: ReconcileInput): ReconcileEntry {
  const { link, remote, localHash } = input;

  // The pull baseline: the remote `updatedAt` we last observed if we have one,
  // otherwise the moment we last pushed (the only remote-side anchor a freshly
  // pushed, never-pulled item has).
  const baselineAt = link.externalUpdatedAt ?? link.lastPushedAt;

  // Local change is only trustworthy when the caller supplied a hash; otherwise
  // local state is unknown (extraction is deferred).
  const localKnown = localHash !== null;
  const localChanged = localKnown && localHash !== link.lastPushedHash;

  // Common identity fields for the entry.
  const base = {
    specItemId: link.specItemId,
    connectionId: link.connectionId,
    externalId: link.externalId,
    externalUrl: link.externalUrl,
    baselineAt,
    localChanged,
    localKnown,
  };

  // The remote vanished: never auto-delete local. Surface the local-change signal
  // and hand it to the user.
  if (remote === null) {
    return {
      ...base,
      classification: 'remote-missing',
      proposedResolution: 'needs-user',
      // remoteChanged is meaningless without a remote; report false.
      remoteChanged: false,
    };
  }

  // Did the remote change since our baseline? Strict `>`: an identical timestamp
  // is "no change". Then demote a content-identical bump using the stored pull
  // hash (a metadata-only `updatedAt` move we must not treat as a real change).
  let remoteChanged =
    new Date(remote.updatedAt).getTime() > new Date(baselineAt).getTime();
  if (remoteChanged && link.lastPulledHash !== undefined) {
    if (computeRemoteHash(remote) === link.lastPulledHash) {
      remoteChanged = false;
    }
  }

  const { classification, proposedResolution } = decide(
    remoteChanged,
    localChanged,
    localKnown,
  );

  return {
    ...base,
    classification,
    proposedResolution,
    remoteUpdatedAt: remote.updatedAt,
    remoteChanged,
  };
}

/**
 * The classification matrix as a pure decision (remote exists). See the module
 * docblock for the table; the load-bearing rule is that remote-changed +
 * unknown-local is a `conflict`, never a silent `adopt-remote`.
 */
function decide(
  remoteChanged: boolean,
  localChanged: boolean,
  localKnown: boolean,
): { classification: ReconcileClassification; proposedResolution: ReconcileResolution } {
  if (!remoteChanged && !localChanged) {
    return { classification: 'unchanged', proposedResolution: 'none' };
  }
  if (remoteChanged && !localKnown) {
    // Can't prove the local item is safe to overwrite ⇒ conflict (safety).
    return { classification: 'conflict', proposedResolution: 'needs-user' };
  }
  if (remoteChanged && !localChanged) {
    // localKnown is true here, and we positively know local did not change.
    return { classification: 'remote-only', proposedResolution: 'adopt-remote' };
  }
  if (remoteChanged && localChanged) {
    return { classification: 'conflict', proposedResolution: 'needs-user' };
  }
  // !remoteChanged && localChanged
  return { classification: 'local-only', proposedResolution: 'keep-local' };
}

/** The resolution a user (or auto-policy) settled on for a reconcile entry. */
export type FinalResolution = 'adopt-remote' | 'keep-local' | 'skip';

/**
 * A reconcile entry paired with the remote it was read from and the final
 * resolution to apply. The remote is carried so {@link applyReconcile} can record
 * the new pull baseline without re-reading.
 */
export interface ResolvedReconcileEntry {
  entry: ReconcileEntry;
  /** The remote state for this entry; `null` when the remote no longer exists. */
  remote: RemoteItemState | null;
  /** What to apply for this entry. */
  resolution: FinalResolution;
}

/**
 * Collaborators {@link applyReconcile} needs, all injected so the module stays
 * DB-free (jsdom can't open SQLite), mirroring {@link PushExecutionDeps}.
 */
export interface ReconcileApplyDeps {
  /**
   * Records the advanced pull baseline for a link after a successful adopt.
   * Production wires `updateSyncLinkPullState`; tests pass an in-memory capture.
   */
  writePullState: (update: {
    specItemId: string;
    connectionId: string;
    externalUpdatedAt: string;
    lastPulledAt: string;
    lastPulledHash: string;
  }) => void;
  /**
   * Current timestamp as ISO-8601. Injectable for deterministic tests. Defaults
   * to `() => new Date().toISOString()`.
   */
  now?: () => string;
}

/** What actually happened to a resolved entry during apply. */
export type ReconcileApplyStatus = 'adopted' | 'kept-local' | 'skipped' | 'failed';

/** Per-entry result of {@link applyReconcile}. */
export interface ReconcileApplyItemResult {
  /** SpecForge-local id of the item. */
  specItemId: string;
  /** The resolution that was applied. */
  resolution: FinalResolution;
  /** The outcome. */
  status: ReconcileApplyStatus;
  /** Failure message, present only when `status === 'failed'`. */
  error?: string;
}

/** The full apply outcome: per-entry results plus tallies by status. */
export interface ReconcileApplyResult {
  /** Per-entry results, in input order. */
  results: ReconcileApplyItemResult[];
  /** Count of entries whose remote baseline was adopted. */
  adopted: number;
  /** Count of entries left as local (intentional no-op on the link). */
  keptLocal: number;
  /** Count of entries skipped. */
  skipped: number;
  /** Count of entries whose apply failed. */
  failed: number;
}

/**
 * Apply a set of resolved reconcile entries, advancing the pull baseline for each
 * adopted remote. Mirrors {@link executePush}: every entry is handled in its own
 * try/catch and the loop logs-and-continues on failure (no enclosing
 * transaction), so one bad entry never aborts the rest.
 *
 * Behavior per resolution:
 *  - **`adopt-remote`** — requires `remote !== null` (an adopt with a vanished
 *    remote is a `failed` result, since there is nothing to adopt). Records the
 *    advanced baseline via `writePullState({ externalUpdatedAt: remote.updatedAt,
 *    lastPulledAt: now(), lastPulledHash: computeRemoteHash(remote) })` → status
 *    `adopted`. **NOTE:** this core only records that the pull baseline advanced
 *    (AC #4: SyncLink is updated after a successful pull). Performing the actual
 *    local-file mutation that brings the local item in line with the remote is the
 *    (out-of-scope) orchestration/extraction layer's job — see the module docblock.
 *  - **`keep-local`** — intentionally writes NOTHING to the link. The local edit
 *    stands and a subsequent push reconciles the remote; advancing the pull
 *    baseline here would record a pull that didn't happen and mask the unadopted
 *    divergence from the next reconcile. Status `kept-local`.
 *  - **`skip`** — no-op. Status `skipped`.
 */
export function applyReconcile(
  resolved: ResolvedReconcileEntry[],
  deps: ReconcileApplyDeps,
): ReconcileApplyResult {
  const { writePullState } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  const results: ReconcileApplyItemResult[] = [];

  for (const { entry, remote, resolution } of resolved) {
    const specItemId = entry.specItemId;
    try {
      if (resolution === 'adopt-remote') {
        if (remote === null) {
          // Nothing to adopt: a vanished remote can't advance the baseline.
          results.push({
            specItemId,
            resolution,
            status: 'failed',
            error: 'adopt-remote resolution has no remote state to adopt',
          });
          continue;
        }
        writePullState({
          specItemId,
          connectionId: entry.connectionId,
          externalUpdatedAt: remote.updatedAt,
          lastPulledAt: now(),
          lastPulledHash: computeRemoteHash(remote),
        });
        results.push({ specItemId, resolution, status: 'adopted' });
        continue;
      }

      if (resolution === 'keep-local') {
        // Deliberately no link write — see the docblock. The local edit wins and
        // a later push reconciles the remote.
        results.push({ specItemId, resolution, status: 'kept-local' });
        continue;
      }

      // resolution === 'skip'
      results.push({ specItemId, resolution, status: 'skipped' });
    } catch (err) {
      // Log-and-continue: one failed apply never aborts the rest, and no link
      // write is left half-done (the only write, `writePullState`, is atomic).
      console.error('[sync] failed to apply reconcile entry', specItemId, err);
      results.push({
        specItemId,
        resolution,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    results,
    adopted: results.filter((r) => r.status === 'adopted').length,
    keptLocal: results.filter((r) => r.status === 'kept-local').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };
}
