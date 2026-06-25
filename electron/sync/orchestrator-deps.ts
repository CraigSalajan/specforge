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
import { buildCanonicalItemsForVault } from './spec-to-canonical';
import { createConnectionSecrets } from './connection-secrets';
import {
  listSyncLinksForConnection,
  upsertSyncLink,
} from '../db/repositories/sync-links.repo';
import { getActiveVaultRoot } from '../ipc/watcher';
import { secretSettingsStore } from '../ipc/settings-secret-store';

/**
 * Builds the production {@link SyncOrchestratorDeps}, binding each injected
 * collaborator to its real main-process implementation. The adapter builder is
 * bound to the encrypted per-connection secret store so the credential is
 * resolved lazily on each request from the at-rest store, never held here.
 */
export function createProductionSyncDeps(): SyncOrchestratorDeps {
  const buildAdapter = createLinearAdapterBuilder(
    createConnectionSecrets(secretSettingsStore),
  );

  return {
    resolveVaultRoot: getActiveVaultRoot,
    readConnection,
    sourceCanonicalItems: buildCanonicalItemsForVault,
    listLinks: listSyncLinksForConnection,
    writeLink: upsertSyncLink,
    buildAdapter,
    now: () => new Date().toISOString(),
  };
}
