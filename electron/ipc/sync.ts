/**
 * IPC seam exposing the sync engine (TER-30) to the renderer.
 *
 * Three *action* channels (test-connection, build-preview, execute-push) and one
 * read-only *list* channel surface the orchestrator (`../sync/orchestrator`) over
 * IPC. Every channel accepts ONLY a `connectionId`/`vaultPath` — never a raw
 * credential. Credentials are resolved main-side inside `deps.buildAdapter` from
 * the encrypted at-rest store (TER-28), so a token never enters renderer memory
 * and no payload here ever carries one.
 *
 * ## Deliberate read/write split — no connection writer lives here
 * Connection *persistence* (save/delete) stays in the renderer's reactive
 * `SettingsService`, which owns the signal-backed `pm.connections` settings cache;
 * a main-side write path would desync that signal. So this module adds only a
 * READ-ONLY `sync-connection-list` plus the three sync *actions*. Save/delete
 * remain on `SettingsService.saveConnection`/`removeConnection`. In short: writes
 * are reactive settings; reads/actions are the sync surface.
 *
 * ## Thin registration shim — pure handlers live in `./sync-handlers`
 * The per-channel `handle*` logic is electron-free and lives in
 * {@link ./sync-handlers}, so the renderer's Vitest/jsdom specs can import and
 * exercise it without pulling in `ipcMain`. This module is only the thin
 * `ipcMain.handle` registration shim — `electron`'s `ipcMain` is its one impure
 * import, and no spec imports it. The impure production wiring lives in the
 * separate, main-only {@link ./sync-deps} (`createProductionSyncContext`).
 */

import { ipcMain } from 'electron';
import {
  handleTestConnection,
  handleBuildPreview,
  handleExecutePush,
  handleConnectionList,
  type SyncIpcContext,
} from './sync-handlers';

export type { SyncIpcContext } from './sync-handlers';

const Channels = {
  SyncTestConnection: 'specforge:sync-test-connection',
  SyncBuildPreview: 'specforge:sync-build-preview',
  SyncExecutePush: 'specforge:sync-execute-push',
  SyncConnectionList: 'specforge:sync-connection-list',
} as const;

/**
 * Registers the sync IPC handlers over the injected {@link SyncIpcContext}.
 *
 * The context is a required parameter (not a production default) precisely so
 * this module never imports the impure `node:sqlite`-backed wiring: main builds
 * it via the main-only `./sync-deps.createProductionSyncContext()` and passes it
 * in. Specs call the exported `handle*` functions (from `./sync-handlers`)
 * directly with fakes, so registration only ever installs thin delegating
 * wrappers. Stateless — no dispose function needed.
 */
export function registerSyncHandlers(ctx: SyncIpcContext): void {
  ipcMain.handle(Channels.SyncTestConnection, (_e, connectionId: string) =>
    handleTestConnection(connectionId, ctx),
  );
  ipcMain.handle(Channels.SyncBuildPreview, (_e, connectionId: string) =>
    handleBuildPreview(connectionId, ctx),
  );
  ipcMain.handle(Channels.SyncExecutePush, (_e, connectionId: string) =>
    handleExecutePush(connectionId, ctx),
  );
  ipcMain.handle(Channels.SyncConnectionList, (_e, vaultPath: string) =>
    handleConnectionList(vaultPath, ctx),
  );
}
