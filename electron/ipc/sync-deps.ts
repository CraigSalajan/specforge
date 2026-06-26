/**
 * Production wiring for the sync IPC handlers (TER-30) — main-only.
 *
 * {@link ./sync} is deliberately spec-importable: its runtime imports are pure so
 * the renderer's Vitest/jsdom specs can exercise the `handle*` functions without
 * loading `node:sqlite`. This file is where the impure {@link SyncIpcContext}
 * collaborators are bound to their real main-process implementations — the sync
 * orchestrator deps, the active-vault watcher, and the connection-store read. It
 * imports the SQLite-backed orchestrator deps and Electron state, so it is
 * **main-only** and is NEVER imported by any spec nor by `./sync` itself. That
 * separation is what keeps `./sync` spec-importable — exactly the
 * `orchestrator` ↔ `orchestrator-deps` split this mirrors.
 *
 * @see ./sync for the pure handlers this binds real I/O into.
 */

import { createProductionSyncDeps } from '../sync/orchestrator-deps';
import { buildEphemeralLinearClient } from '../sync/orchestrator';
import { readConnectionsForVault } from '../sync/connection-store';
import type { SyncIpcContext } from './sync';

/**
 * Builds the production {@link SyncIpcContext}, binding each collaborator to its
 * real main-process implementation. The orchestrator deps resolve both the active
 * vault root (via `resolveVaultRoot`) and the credential lazily from the encrypted
 * at-rest store on each request, never holding the credential here.
 */
export function createProductionSyncContext(): SyncIpcContext {
  return {
    deps: createProductionSyncDeps(),
    listConnections: readConnectionsForVault,
    // TER-31: discovery builds an ephemeral PAT-authed client (the only path
    // where the credential is passed in rather than resolved from the store).
    buildDiscoveryClient: buildEphemeralLinearClient,
  };
}
