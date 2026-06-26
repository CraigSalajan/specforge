/**
 * Production wiring for the sync orchestrator (TER-29) — main-only.
 *
 * {@link ../sync/orchestrator} is deliberately pure and DB-free: every impure
 * collaborator arrives through an injected {@link SyncOrchestratorDeps}. This
 * file is where those collaborators are bound to the real main-process
 * implementations — the active-vault watcher, the connection read API, the
 * spec→canonical converter, the SyncLink repo, and the encrypted per-connection
 * secret store. It imports the SQLite-backed repos and Electron state, so it is
 * **main-only** and is NEVER imported by any spec (which run under jsdom and
 * cannot load `node:sqlite`) nor by `orchestrator.ts` itself. That separation is
 * what keeps `orchestrator.ts` spec-importable.
 *
 * @see ./orchestrator for the pure core this binds real I/O into.
 */

import {
  createLinearAdapterBuilder,
  type SyncOrchestratorDeps,
} from './orchestrator';
import { readConnection } from './connection-store';
import {
  buildCanonicalItemsForVault,
  buildTaskItemsForFile,
} from './spec-to-canonical';
import { getOAuthRuntimeContext } from './oauth-context';
import {
  listSyncLinksForConnection,
  upsertSyncLink,
} from '../db/repositories/sync-links.repo';
import { getActiveVaultRoot } from '../ipc/watcher';

/**
 * Builds the production {@link SyncOrchestratorDeps}, binding each injected
 * collaborator to its real main-process implementation. The adapter builder is
 * bound to the encrypted per-connection secret store (PAT path) and the shared
 * OAuth token manager (OAuth path) from {@link getOAuthRuntimeContext}, so the
 * credential is resolved lazily on each request — a PAT read from the at-rest
 * store, or a live access token minted/refreshed by the manager — never held here.
 */
export function createProductionSyncDeps(): SyncOrchestratorDeps {
  const oauth = getOAuthRuntimeContext();
  const buildAdapter = createLinearAdapterBuilder(oauth.secrets, oauth.tokenManager);

  return {
    resolveVaultRoot: getActiveVaultRoot,
    readConnection,
    // Routing guard — a per-file push must NEVER silently degrade to the
    // whole-vault converter, which is FLAT-dropping for stories (it emits stories as
    // `{title, criteria}` only, losing the structured description/open-questions/
    // risks — the TER-37 regression). So:
    //   - `filePath` present  → the per-file FLAT, stories-only source
    //     (`buildTaskItemsForFile` → `buildTaskItemsFromContent`), which carries the
    //     full structured `description` + `criteria` for each AI-tagged `sf:id` story
    //     and NEVER the epic/themes/prose. This is the `/push-file` path.
    //   - `filePath` absent   → the whole-vault Push button: parse the entire `/prd`
    //     heading structure (`buildCanonicalItemsForVault`). ONLY this explicit
    //     no-filePath case may reach the whole-vault converter.
    // Story localIds are the marker ids in BOTH paths, so re-runs update rather than
    // duplicate. (The combined `/decompose-stories` execute does not flow through here
    // at all — it pushes its previewed in-memory items via `planPushFromItems`.)
    sourceCanonicalItems: (root, filePath) =>
      filePath ? buildTaskItemsForFile(root, filePath) : buildCanonicalItemsForVault(root),
    listLinks: listSyncLinksForConnection,
    writeLink: upsertSyncLink,
    buildAdapter,
    now: () => new Date().toISOString(),
  };
}
