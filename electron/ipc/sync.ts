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
 * ## Result-envelope pattern (mirrors `./ai`)
 * `ipcMain.handle` rejections are stringified by Electron with an `Error invoking
 * remote method '…'` prefix, so the three action channels return failures as data
 * — `{ ok: true, data } | { ok: false, error }` — where `error` reuses the shared
 * {@link AiErrorInfo} vocabulary (a `LinearRequestError` carries exactly this in
 * `.info`). The renderer's `SyncService` unwraps the envelope.
 *
 * ## Purity contract — this file must stay spec-importable
 * Like `../sync/orchestrator`, this module's runtime imports are kept pure
 * (`./orchestrator`, `./linear/errors`; everything else is type-only) so the
 * renderer's Vitest/jsdom specs can import the exported `handle*` functions
 * without dragging in `node:sqlite`. The impure production wiring lives in the
 * separate, main-only {@link ./sync-deps} (`createProductionSyncContext`), which
 * no spec imports — exactly the `orchestrator` ↔ `orchestrator-deps` split.
 * `electron`'s `ipcMain` is the one impure import here; specs mock it.
 *
 * ## Testability seam
 * Per-channel logic lives in exported pure async functions taking an injected
 * {@link SyncIpcContext} (the orchestrator deps + a vault-wide connection
 * lister), so specs exercise them with in-memory fakes. The thin `ipcMain.handle`
 * wrappers in {@link registerSyncHandlers} only delegate. The active-vault root is
 * resolved through the orchestrator deps' own `resolveVaultRoot` so every handler
 * shares a single resolver rather than a divergent second one.
 */

import { ipcMain } from 'electron';
import {
  planPushForConnection,
  runSyncPush,
} from '../sync/orchestrator';
import { LinearRequestError } from '../sync/linear/errors';
import type { SyncOrchestratorDeps } from '../sync/orchestrator';
import type { AiErrorInfo } from './ai-error';
import type { AdapterName, ProjectMetadata } from '../sync/adapter';
import type { PushPreviewTree } from '../sync/preview';
import type { PushResult } from '../sync/executor';
import type { Connection } from '../sync/connection';

const Channels = {
  SyncTestConnection: 'specforge:sync-test-connection',
  SyncBuildPreview: 'specforge:sync-build-preview',
  SyncExecutePush: 'specforge:sync-execute-push',
  SyncConnectionList: 'specforge:sync-connection-list',
} as const;

/**
 * Injected collaborators the per-channel handlers need. Production binds `deps`
 * to `createProductionSyncDeps()` and `listConnections` to the connection-store
 * read; specs pass in-memory fakes. The active-vault root comes from
 * `deps.resolveVaultRoot`, so no separate vault resolver lives here.
 */
export interface SyncIpcContext {
  /** The production (or fake) sync orchestrator dependencies. */
  deps: SyncOrchestratorDeps;
  /** Reads every persisted connection for a vault (non-secret, read-only). */
  listConnections: (vaultPath: string) => Connection[];
}

/** Discriminated result for {@link handleTestConnection}. */
export type SyncTestConnectionResult =
  | { ok: true; data: ProjectMetadata }
  | { ok: false; error: AiErrorInfo };

/** The serializable preview subset returned by {@link handleBuildPreview}. */
export interface SyncPreviewData {
  provider: AdapterName;
  preview: PushPreviewTree;
}

/** Discriminated result for {@link handleBuildPreview}. */
export type SyncBuildPreviewResult =
  | { ok: true; data: SyncPreviewData }
  | { ok: false; error: AiErrorInfo };

/** Discriminated result for {@link handleExecutePush}. */
export type SyncExecutePushResult =
  | { ok: true; data: PushResult | null }
  | { ok: false; error: AiErrorInfo };

function assertConnectionId(connectionId: unknown): asserts connectionId is string {
  if (typeof connectionId !== 'string' || connectionId.length === 0 || connectionId.length > 256) {
    throw new Error('Invalid connection id');
  }
}

function assertVaultPath(vaultPath: unknown): asserts vaultPath is string {
  if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
    throw new Error('Invalid vault path');
  }
}

/**
 * Maps an unknown thrown value to the shared {@link AiErrorInfo} envelope: a
 * `LinearRequestError` surrenders its structured `.info` verbatim; anything else
 * becomes a generic, non-retryable `unknown` error carrying a string message.
 */
function toErrorInfo(err: unknown): AiErrorInfo {
  if (err instanceof LinearRequestError) {
    return err.info;
  }
  const message =
    err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
  return { code: 'unknown', message, retryable: false };
}

/**
 * Test a connection by fetching the target project's metadata through its
 * adapter. The credential is resolved main-side inside `deps.buildAdapter`; only
 * a `connectionId` crosses the IPC boundary and only non-secret
 * {@link ProjectMetadata} comes back.
 */
export async function handleTestConnection(
  connectionId: string,
  ctx: SyncIpcContext,
): Promise<SyncTestConnectionResult> {
  try {
    assertConnectionId(connectionId);
    const vaultPath = ctx.deps.resolveVaultRoot();
    if (vaultPath === null) {
      throw new Error('No active vault; open a vault before testing a connection.');
    }
    const conn = ctx.deps.readConnection(vaultPath, connectionId);
    if (conn === undefined) {
      throw new Error(`Unknown connection: ${connectionId}`);
    }
    const adapter = ctx.deps.buildAdapter(conn);
    const data = await adapter.getMetadata();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorInfo(err) };
  }
}

/**
 * Build the read-only push preview for a connection (no network, writes nothing).
 * Returns ONLY the serializable subset — `provider` + `preview` — dropping the
 * non-serializable `adapter` and the bulky `items`/`plan` the renderer does not
 * need to render the confirmation tree.
 */
export async function handleBuildPreview(
  connectionId: string,
  ctx: SyncIpcContext,
): Promise<SyncBuildPreviewResult> {
  try {
    assertConnectionId(connectionId);
    const planned = planPushForConnection(connectionId, ctx.deps);
    return { ok: true, data: { provider: planned.provider, preview: planned.preview } };
  } catch (err) {
    return { ok: false, error: toErrorInfo(err) };
  }
}

/**
 * Plan + execute the push for a connection. The renderer's preview is the
 * approval gate, so the orchestrator's default `approve` (always true) is used
 * here. Returns the serializable {@link PushResult} (or `null` if a future gate
 * declines).
 */
export async function handleExecutePush(
  connectionId: string,
  ctx: SyncIpcContext,
): Promise<SyncExecutePushResult> {
  try {
    assertConnectionId(connectionId);
    const { result } = await runSyncPush(connectionId, ctx.deps);
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: toErrorInfo(err) };
  }
}

/**
 * List the persisted connections for a vault — a plain read that cannot fail
 * meaningfully (a malformed store yields `[]`), so it returns the bare
 * {@link Connection}[] with no envelope. Connections carry no credential.
 */
export async function handleConnectionList(
  vaultPath: string,
  ctx: SyncIpcContext,
): Promise<Connection[]> {
  assertVaultPath(vaultPath);
  return ctx.listConnections(vaultPath);
}

/**
 * Registers the sync IPC handlers over the injected {@link SyncIpcContext}.
 *
 * The context is a required parameter (not a production default) precisely so
 * this module never imports the impure `node:sqlite`-backed wiring: main builds
 * it via the main-only `./sync-deps.createProductionSyncContext()` and passes it
 * in. Specs call the exported `handle*` functions directly with fakes, so
 * registration only ever installs thin delegating wrappers. Stateless — no
 * dispose function needed.
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
