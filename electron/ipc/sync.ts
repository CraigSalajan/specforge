/**
 * IPC seam exposing the sync engine (TER-30) to the renderer.
 *
 * The *action* channels (test-connection, build-preview, execute-push, plus the
 * TER-37 combined-review pair preview-from-items / execute-push-from-items) and one
 * read-only *list* channel surface the orchestrator (`../sync/orchestrator`) over
 * IPC. Every channel accepts ONLY non-secret params — a `connectionId`/`vaultPath`,
 * (TER-37) an optional `filePath` on build-preview/execute-push naming the active
 * markdown file (any folder) to push, or (TER-37) renderer-computed canonical
 * `items` on the from-items pair — never a raw credential. Credentials are resolved
 * main-side inside `deps.buildAdapter` from the encrypted at-rest store (TER-28),
 * so a token never enters renderer memory and no payload here ever carries one.
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

import { ipcMain, type WebContents } from 'electron';
import {
  handleTestConnection,
  handleBuildPreview,
  handlePreviewFromItems,
  handleExecutePush,
  handleExecutePushFromItems,
  handleConnectionList,
  handleListTeams,
  handleListProjects,
  type SyncIpcContext,
} from './sync-handlers';
import type { AdapterName } from '../sync/adapter';
import type { CanonicalItem } from '../sync/canonical-item';
import type { ItemProgressEvent } from '../sync/executor';

export type { SyncIpcContext } from './sync-handlers';

/**
 * The live-progress event the main process pushes to the renderer over
 * {@link Channels.SyncPushProgress}: an executor {@link ItemProgressEvent}
 * stamped with the renderer's `pushId` so the renderer can demux it against the
 * push it actually started (and ignore a stale/overlapping one).
 */
export type SyncPushProgressEvent = ItemProgressEvent & { pushId: string };

/**
 * Send guard mirroring `./ai`'s: a streamed push can still be in flight when the
 * window is torn down, so never `send` to a destroyed renderer (it throws).
 */
function safeSend(sender: WebContents, channel: string, payload: unknown): void {
  if (sender.isDestroyed()) return;
  sender.send(channel, payload);
}

/**
 * Builds the per-call progress sink the execute handlers forward to the executor,
 * or `undefined` when the renderer did not supply a `pushId` (the original, no-op
 * path). Each executor event is stamped with the `pushId` and sent over
 * {@link Channels.SyncPushProgress}, guarded against a torn-down renderer.
 */
function onProgressSender(
  sender: WebContents,
  pushId: string | undefined,
): ((ev: ItemProgressEvent) => void) | undefined {
  if (pushId === undefined) return undefined;
  return (ev: ItemProgressEvent): void => {
    const payload: SyncPushProgressEvent = { ...ev, pushId };
    safeSend(sender, Channels.SyncPushProgress, payload);
  };
}

const Channels = {
  SyncTestConnection: 'specforge:sync-test-connection',
  SyncBuildPreview: 'specforge:sync-build-preview',
  // TER-37: preview from renderer-computed, not-yet-written items (combined
  // decompose-and-push review).
  SyncPreviewFromItems: 'specforge:sync-preview-from-items',
  SyncExecutePush: 'specforge:sync-execute-push',
  // TER-37: execute the push from the SAME renderer-computed items the combined
  // review previewed — so Linear receives the full structured stories, not a
  // disk re-read reshaped by the whole-vault converter.
  SyncExecutePushFromItems: 'specforge:sync-execute-push-from-items',
  // TER-37 (live progress): a renderer→main→renderer event channel. Both execute
  // channels stream one event per `ItemProgressEvent` (start/done) so the push
  // modal renders a live per-item list instead of a static "Pushing…" line. The
  // renderer passes a `pushId` into the execute invoke; every event carries it
  // back so a stale/overlapping push can be demuxed and ignored.
  SyncPushProgress: 'specforge:sync-push-progress',
  SyncConnectionList: 'specforge:sync-connection-list',
  // TER-31: team/project discovery — the PAT crosses for discovery only (see
  // the security note on handleListTeams in ./sync-handlers).
  SyncListTeams: 'specforge:sync-list-teams',
  SyncListProjects: 'specforge:sync-list-projects',
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
  ipcMain.handle(Channels.SyncBuildPreview, (_e, connectionId: string, filePath?: string) =>
    handleBuildPreview(connectionId, ctx, filePath),
  );
  ipcMain.handle(
    Channels.SyncPreviewFromItems,
    (_e, connectionId: string, items: CanonicalItem[]) =>
      handlePreviewFromItems(connectionId, items, ctx),
  );
  ipcMain.handle(
    Channels.SyncExecutePush,
    (e, connectionId: string, filePath?: string, pushId?: string) =>
      // When the renderer supplies a `pushId`, stream each executor progress
      // event back to it (stamped with that id); otherwise no progress sink is
      // passed and the push behaves exactly as before. Guarded against a
      // destroyed renderer (the window can close mid-push).
      handleExecutePush(connectionId, ctx, filePath, onProgressSender(e.sender, pushId)),
  );
  ipcMain.handle(
    Channels.SyncExecutePushFromItems,
    (e, connectionId: string, items: CanonicalItem[], pushId?: string) =>
      handleExecutePushFromItems(connectionId, items, ctx, onProgressSender(e.sender, pushId)),
  );
  ipcMain.handle(Channels.SyncConnectionList, (_e, vaultPath: string) =>
    handleConnectionList(vaultPath, ctx),
  );
  ipcMain.handle(Channels.SyncListTeams, (_e, provider: AdapterName, pat: string) =>
    handleListTeams({ provider, pat }, ctx),
  );
  ipcMain.handle(
    Channels.SyncListProjects,
    (_e, provider: AdapterName, pat: string, teamId: string) =>
      handleListProjects({ provider, pat, teamId }, ctx),
  );
}
