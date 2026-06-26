/**
 * Electron-free sync handler logic (TER-30).
 *
 * This module holds the pure, per-channel `handle*` functions for the sync IPC
 * seam. It deliberately imports NO `electron` — only the pure orchestrator and
 * its error type — so the renderer's Vitest/jsdom specs can import and exercise
 * these handlers directly without dragging in `ipcMain` (whose presence would
 * force conflicting partial `electron` mocks across specs). The thin
 * `ipcMain.handle` registration shim lives in {@link ./sync}.
 *
 * ## Security — no credential ever crosses the boundary
 * Every channel accepts ONLY non-secret params — a `connectionId`/`vaultPath`,
 * and (TER-37) an optional `filePath` naming the active markdown file to push.
 * No channel accepts a raw credential. Credentials are resolved main-side inside
 * `deps.buildAdapter` from the encrypted at-rest store (TER-28), so a token never
 * enters renderer memory and no payload here ever carries one. The `filePath`
 * param is validated (`.md`, no traversal/absolute/drive-letter) before it is
 * threaded to the orchestrator's file-scoped item source.
 *
 * ## Deliberate read/write split — no connection writer lives here
 * Connection *persistence* (save/delete) stays in the renderer's reactive
 * `SettingsService`, which owns the signal-backed `pm.connections` settings cache;
 * a main-side write path would desync that signal. So this module exposes only a
 * READ-ONLY `handleConnectionList` plus the three sync *actions*. Save/delete
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
 * ## Testability seam
 * Per-channel logic lives in exported pure async functions taking an injected
 * {@link SyncIpcContext} (the orchestrator deps + a vault-wide connection
 * lister), so specs exercise them with in-memory fakes. The active-vault root is
 * resolved through the orchestrator deps' own `resolveVaultRoot` so every handler
 * shares a single resolver rather than a divergent second one.
 */

import {
  executePlannedPush,
  planPushForConnection,
  planPushFromItems,
  runSyncPush,
} from '../sync/orchestrator';
import { LinearRequestError } from '../sync/linear/errors';
import { discoverProjects, discoverTeams } from '../sync/linear/discovery';
import type { SyncOrchestratorDeps } from '../sync/orchestrator';
import type { CanonicalItem } from '../sync/canonical-item';
import type { AiErrorInfo } from './ai-error';
import type {
  AdapterName,
  LinearProject,
  LinearTeam,
  ProjectMetadata,
} from '../sync/adapter';
import type { LinearGraphQLClient } from '../sync/linear/client';
import type { PushPreviewTree } from '../sync/preview';
import type { PushResult, ItemProgressEvent } from '../sync/executor';
import type { Connection } from '../sync/connection';

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
  /**
   * Builds an EPHEMERAL Linear GraphQL client authenticated with the supplied
   * raw PAT, for team/project discovery only (TER-31). Discovery runs *before*
   * any persisted connection exists, so — unlike every other channel here — the
   * credential cannot be resolved main-side from a `connectionId`; it must be
   * passed in. The built client is never persisted and the PAT it closes over is
   * never logged, stored, or returned. Production binds this in `./sync-deps`;
   * specs pass a fake that records the PAT.
   */
  buildDiscoveryClient: (pat: string) => LinearGraphQLClient;
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

/** Discriminated result for {@link handleListTeams} (TER-31). */
export type SyncListTeamsResult =
  | { ok: true; data: LinearTeam[] }
  | { ok: false; error: AiErrorInfo };

/** Discriminated result for {@link handleListProjects} (TER-31). */
export type SyncListProjectsResult =
  | { ok: true; data: LinearProject[] }
  | { ok: false; error: AiErrorInfo };

/**
 * Validates the raw PAT that crosses IPC for discovery (TER-31). A non-empty
 * string within a sane bound — the value is never logged, so the assertion
 * message deliberately omits it.
 */
function assertPat(pat: unknown): asserts pat is string {
  if (typeof pat !== 'string' || pat.length === 0 || pat.length > 4096) {
    throw new Error('Invalid PAT');
  }
}

/**
 * Validates the discovery provider. Only `'linear'` exists in V1; the discovery
 * client builder is Linear-specific, so reject anything else with a clear error.
 */
function assertDiscoveryProvider(provider: unknown): asserts provider is 'linear' {
  if (provider !== 'linear') {
    throw new Error(`Unsupported discovery provider: ${String(provider)}`);
  }
}

function assertTeamId(teamId: unknown): asserts teamId is string {
  if (typeof teamId !== 'string' || teamId.length === 0 || teamId.length > 256) {
    throw new Error('Invalid team id');
  }
}

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
 * Validates the per-file push target (TER-37). The path is a vault-relative
 * markdown file (any folder — the AI does the decomposition, so the source
 * file's location is irrelevant), never a credential, but it IS consumed by a
 * main-side `readFileSync`, so it is hardened against traversal before it reaches
 * the orchestrator.
 *
 * Mirrors the renderer's `isSafeRelPath` (src/app/features/ai/providers/path-utils.ts)
 * — replicated here rather than cross-imported, since this module deliberately
 * imports only pure sync modules — PLUS a `.md` extension requirement. Rejects
 * empty/non-string, absolute paths, ANY Windows drive prefix (`C:\`, `C:/`, and
 * the drive-relative `C:foo.md`), and any `.`/`..` segment.
 */
function assertFilePath(filePath: unknown): asserts filePath is string {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Invalid file path');
  }
  // Reject ANY Windows drive prefix (`C:\`, `C:/`, AND the drive-RELATIVE form
  // `C:foo.md`). The drive-relative form has no separator after the colon, so a
  // `[a-zA-Z]:[\\/]` check misses it — yet `path.resolve(root, 'D:foo.md')`
  // resolves to the root of drive D (and `C:foo.md` to the cwd of drive C),
  // escaping the vault entirely. Matching the bare `[a-zA-Z]:` prefix closes
  // both the absolute and the drive-relative bypass.
  if (/^[a-zA-Z]:/.test(filePath)) {
    throw new Error('Invalid file path');
  }
  if (filePath.startsWith('/') || filePath.startsWith('\\')) {
    throw new Error('Invalid file path');
  }
  const normalized = filePath.replace(/\\/g, '/');
  for (const seg of normalized.split('/')) {
    if (seg === '..' || seg === '.' || seg.length === 0) {
      throw new Error('Invalid file path');
    }
  }
  // Per-file push targets a markdown file in any vault folder.
  if (!/\.md$/i.test(normalized)) {
    throw new Error('Invalid file path');
  }
}

/**
 * Validates the pre-built canonical items that cross IPC for the combined
 * decompose-and-push preview (TER-37). They are renderer-computed and never a
 * credential, but they ARE planned against the connection's SyncLinks, so each
 * must be a well-formed {@link CanonicalItem} (non-empty string `localId`, a valid
 * `level`, a string `title`). A bounded array guards against a runaway payload.
 */
function assertCanonicalItems(items: unknown): asserts items is CanonicalItem[] {
  if (!Array.isArray(items) || items.length > 5000) {
    throw new Error('Invalid canonical items');
  }
  const levels = new Set(['epic', 'feature', 'story', 'criterion']);
  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('Invalid canonical items');
    }
    const it = item as Record<string, unknown>;
    if (typeof it['localId'] !== 'string' || it['localId'].length === 0) {
      throw new Error('Invalid canonical items');
    }
    if (typeof it['level'] !== 'string' || !levels.has(it['level'])) {
      throw new Error('Invalid canonical items');
    }
    if (typeof it['title'] !== 'string') {
      throw new Error('Invalid canonical items');
    }
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
 * need to render the confirmation tree. The preview is advisory: {@link
 * handleExecutePush} re-plans at execute time (see its note on the TOCTOU
 * window), so treat this as the set to confirm rather than a binding plan.
 */
export async function handleBuildPreview(
  connectionId: string,
  ctx: SyncIpcContext,
  filePath?: string,
): Promise<SyncBuildPreviewResult> {
  try {
    assertConnectionId(connectionId);
    // Per-file push (TER-37): when a target markdown file is supplied, validate +
    // scope the preview to it; otherwise the whole-vault behavior is unchanged.
    if (filePath !== undefined) assertFilePath(filePath);
    const planned = planPushForConnection(connectionId, ctx.deps, filePath);
    return { ok: true, data: { provider: planned.provider, preview: planned.preview } };
  } catch (err) {
    return { ok: false, error: toErrorInfo(err) };
  }
}

/**
 * Build the read-only push preview from PRE-BUILT canonical items (TER-37 — the
 * combined decompose-and-push review). The renderer computes the items in-memory
 * from the AI's *proposed* (not-yet-written) doc content via
 * `buildCanonicalItemsFromContent`, so the user can review what the push will do
 * BEFORE anything is written to disk — while idempotency is still resolved against
 * the connection's real, persisted SyncLinks (so previously-pushed stories show as
 * update/skip, new ones as create).
 *
 * The matching apply half is {@link handleExecutePushFromItems}: the combined
 * `/decompose-stories` flow writes the doc first (so disk stays the source of
 * truth for any later re-push), then executes the push from these SAME in-memory
 * items — NOT a disk re-read — so what lands in Linear is provably identical to the
 * previewed structured stories (statement / description / open questions / risks),
 * which a re-plan from disk via the whole-vault converter would otherwise drop.
 */
export async function handlePreviewFromItems(
  connectionId: string,
  items: unknown,
  ctx: SyncIpcContext,
): Promise<SyncBuildPreviewResult> {
  try {
    assertConnectionId(connectionId);
    assertCanonicalItems(items);
    const planned = planPushFromItems(connectionId, items, ctx.deps);
    return { ok: true, data: { provider: planned.provider, preview: planned.preview } };
  } catch (err) {
    return { ok: false, error: toErrorInfo(err) };
  }
}

/**
 * Plan + execute a push from PRE-BUILT canonical items (TER-37 — the apply half of
 * the combined decompose-and-push review). The renderer passes the EXACT items it
 * already previewed via {@link handlePreviewFromItems} (built in-memory from the
 * AI's proposed doc content), so the executed plan carries the full structured story
 * `description` (statement + description + `**Open questions**` + `**Risks**`) and
 * `criteria` — not the title+criteria-only shape a re-plan from disk through the
 * whole-vault converter would yield.
 *
 * Idempotency is unchanged: every item's `localId` is its `sf:id` marker id, so the
 * push resolves create/update/skip against the connection's persisted SyncLinks just
 * as a disk-sourced plan would, and a re-run UPDATES rather than duplicates.
 *
 * The renderer preview is the approval gate, so this always applies (no second
 * gate). Returns the serializable {@link PushResult}.
 *
 * `onProgress` is an OPTIONAL, ELECTRON-FREE per-item progress sink: this module
 * forbids importing `electron` (see the module docblock), so it accepts a PLAIN
 * callback and forwards it to the executor. The registration shim in `./sync`
 * (which already imports electron) is what turns each event into a `sender.send`.
 */
export async function handleExecutePushFromItems(
  connectionId: string,
  items: unknown,
  ctx: SyncIpcContext,
  onProgress?: (ev: ItemProgressEvent) => void,
): Promise<SyncExecutePushResult> {
  try {
    assertConnectionId(connectionId);
    assertCanonicalItems(items);
    const planned = planPushFromItems(connectionId, items, ctx.deps);
    const result = await executePlannedPush(planned, ctx.deps, onProgress);
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: toErrorInfo(err) };
  }
}

/**
 * Plan + execute the push for a connection. The renderer's preview is the
 * approval gate, so the orchestrator's default `approve` (always true) is used
 * here. Returns the serializable {@link PushResult} (or `null` if a future gate
 * declines).
 *
 * Re-plans from live vault state rather than replaying the exact plan shown by
 * {@link handleBuildPreview}: a `PlannedPush` holds a non-serializable adapter
 * instance and so cannot cross the IPC boundary to be handed back here. The
 * preview is therefore advisory — if the vault changes between preview and
 * execute, the applied set can differ. This is a deliberate, bounded TOCTOU
 * window; a future tightening could thread an approved-plan hash through to
 * reject a diverged plan.
 *
 * Known limitation inherited from the executor (not introduced by this IPC
 * seam): item creates are idempotent only via persisted SyncLinks, so a partial
 * retry where the remote create succeeded but its SyncLink write did not can
 * re-create the item. Durable create-before-link reconciliation belongs to the
 * sync engine and is out of scope here.
 *
 * `onProgress` is an OPTIONAL, ELECTRON-FREE per-item progress sink — same
 * contract as {@link handleExecutePushFromItems}: a plain callback forwarded to
 * the executor (through the orchestrator's default-approve `runSyncPush`), turned
 * into `sender.send` by the registration shim in `./sync`.
 */
export async function handleExecutePush(
  connectionId: string,
  ctx: SyncIpcContext,
  filePath?: string,
  onProgress?: (ev: ItemProgressEvent) => void,
): Promise<SyncExecutePushResult> {
  try {
    assertConnectionId(connectionId);
    // Per-file push (TER-37): validate + scope to the target file when supplied;
    // the default-approve gate is preserved (the renderer preview is the gate).
    if (filePath !== undefined) assertFilePath(filePath);
    const { result } = await runSyncPush(connectionId, ctx.deps, undefined, filePath, onProgress);
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
 * List the teams a raw PAT can see, for the Settings → Integrations picker
 * (TER-31).
 *
 * ## SECURITY — scoped deviation from "no credentials over IPC"
 * Every other channel in this module accepts only a `connectionId`/`vaultPath`,
 * because a connection's credential is resolved main-side from the encrypted
 * store. Discovery is the one exception: it must run *before* any connection (and
 * thus any stored credential) exists, so the raw PAT crosses renderer→main here.
 * The PAT is used to build an EPHEMERAL client and is then discarded — it is
 * NEVER logged, persisted, or returned to the renderer, and only the non-secret
 * {@link LinearTeam}[] (or an error envelope) comes back. The provider is
 * validated to be `'linear'` before the PAT is touched.
 */
export async function handleListTeams(
  args: { provider: AdapterName; pat: string },
  ctx: SyncIpcContext,
): Promise<SyncListTeamsResult> {
  try {
    assertDiscoveryProvider(args.provider);
    assertPat(args.pat);
    const client = ctx.buildDiscoveryClient(args.pat);
    const data = await discoverTeams(client);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorInfo(err) };
  }
}

/**
 * List the projects under a team for a raw PAT, for the Settings → Integrations
 * picker (TER-31). The same scoped-PAT security note as {@link handleListTeams}
 * applies: the PAT crosses the boundary for discovery only, is used to build an
 * ephemeral client, and is never logged, persisted, or returned.
 */
export async function handleListProjects(
  args: { provider: AdapterName; pat: string; teamId: string },
  ctx: SyncIpcContext,
): Promise<SyncListProjectsResult> {
  try {
    assertDiscoveryProvider(args.provider);
    assertPat(args.pat);
    assertTeamId(args.teamId);
    const client = ctx.buildDiscoveryClient(args.pat);
    const data = await discoverProjects(client, args.teamId);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorInfo(err) };
  }
}
