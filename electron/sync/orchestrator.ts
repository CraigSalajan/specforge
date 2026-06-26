/**
 * Sync orchestrator — the runnable composition of a Push (TER-29).
 *
 * Steps 1–4 of a Push each live in their own pure, dependency-injected module:
 * {@link planPush} orders + diffs the items, {@link buildPushPreview} turns that
 * plan into a review tree, and {@link executePush} drives the adapter and writes
 * a {@link SyncLink} per successful write. Until now nothing wired them together
 * into a single runnable entry point — `executePush` had zero production callers.
 * This module is that composition: it resolves *which* items go to *which*
 * connection, plans the push, surfaces a preview for approval, and (on approval)
 * executes it — exactly the pipeline the live e2e harness (`e2e/linear/run.ts`)
 * proves end-to-end, minus the env-var/in-memory shims.
 *
 * ## Purity contract — this file must stay spec-importable
 * The engine specs in `src/app/shared/*.spec.ts` import these sync modules and
 * run under Vitest/jsdom, which cannot open SQLite or touch `electron`/`fs`.
 * Therefore this module imports ONLY pure sibling modules at runtime
 * (`./sync-engine`, `./preview`, `./executor`, `./adapter-registry`,
 * `./connection`, `./linear/client`, `./linear/auth`). Every impure collaborator
 * — the active-vault root, the connection read, the canonical-item source, the
 * SyncLink read/write, the credential/vault resolution — arrives through the
 * injected {@link SyncOrchestratorDeps}. DB/secret-store types are imported
 * **type-only** (erased at compile time). The real impure wiring lives in the
 * main-only `./orchestrator-deps`, which no spec imports.
 *
 * ## Approve-then-apply (AI proposes, user disposes)
 * {@link planPushForConnection} is a read-only proposal — it touches no network
 * and writes nothing. {@link executePlannedPush} is the apply half, run only
 * after the {@link PushPreviewTree} has been approved. {@link runSyncPush} chains
 * the two through an `approve` gate (default: always approve) so callers get the
 * whole flow in one call while preserving the gate.
 *
 * ## connectionId threading
 * The persisted `conn.connectionId` is read once and threaded through the entire
 * push — into `listLinks`, the preview, and every written link. It is NEVER
 * recomputed (`sync_links` is keyed on it; recomputing would orphan every
 * existing link — see {@link ./connection.makeConnectionId}).
 *
 * @see ./sync-engine for {@link planPush}.
 * @see ./preview for {@link buildPushPreview}.
 * @see ./executor for {@link executePush}.
 * @see ./orchestrator-deps for the main-only production {@link SyncOrchestratorDeps}.
 * @see ../../e2e/linear/run.ts for the live end-to-end proof of this pipeline.
 */

import { planPush, type PushPlan, type SyncLinkResolver } from './sync-engine';
import { buildPushPreview, type PushPreviewTree } from './preview';
import { executePush, type PushResult } from './executor';
import { ADAPTER_REGISTRY } from './adapter-registry';
import { connectionToLinearConfig, type Connection } from './connection';
import { LinearGraphQLClient } from './linear/client';
import { OAuthAuth, PatAuth } from './linear/auth';
import type { AdapterName, IAdapter } from './adapter';
import type { CanonicalItem } from './canonical-item';
// Type-only: erased at compile time so this module never loads node:sqlite/fs.
import type { SyncLink } from '../db/repositories/sync-links.repo';
import type { ConnectionSecrets } from './connection-secrets';
import type { OAuthTokenManager } from './linear/oauth/token-manager';

/**
 * The impure collaborators {@link planPushForConnection} /
 * {@link executePlannedPush} need, all injected so this module stays DB-free,
 * fs-free, and Electron-free (see the module docblock). Production binds these in
 * `./orchestrator-deps`; tests pass in-memory fakes.
 */
export interface SyncOrchestratorDeps {
  /** Absolute path of the active vault, or `null` when no vault is open. */
  resolveVaultRoot(): string | null;
  /** Reads the persisted, non-secret connection by id within a vault. */
  readConnection(vaultPath: string, connectionId: string): Connection | undefined;
  /** Builds the provider-agnostic canonical items to push from a vault's specs. */
  sourceCanonicalItems(vaultPath: string): CanonicalItem[];
  /** Reads every existing SyncLink for a connection (one query → map lookup). */
  listLinks(connectionId: string): SyncLink[];
  /** Persists a SyncLink after a successful create/update. */
  writeLink(link: SyncLink): void;
  /** Builds the concrete provider adapter (credential-bearing) for a connection. */
  buildAdapter(conn: Connection): IAdapter;
  /** Current timestamp as ISO-8601; injectable for deterministic tests. */
  now?(): string;
}

/**
 * The read-only output of {@link planPushForConnection}: everything needed to
 * render a preview for approval and, on approval, to execute the push without
 * re-resolving anything.
 */
export interface PlannedPush {
  /** The persisted connection id this push targets (threaded, never recomputed). */
  connectionId: string;
  /** The target PM provider. */
  provider: AdapterName;
  /** The canonical items the push will operate over. */
  items: CanonicalItem[];
  /** The topologically ordered create/update/skip plan. */
  plan: PushPlan;
  /** The hierarchical, read-only preview tree the UI renders for confirmation. */
  preview: PushPreviewTree;
  /** The concrete provider adapter the execute step will drive. */
  adapter: IAdapter;
}

/**
 * Plan a push for a connection — the read-only proposal half (AI proposes).
 *
 * Resolves the active vault, the persisted connection, the canonical items, and
 * the connection's existing SyncLinks, then produces a {@link PushPlan} and a
 * {@link PushPreviewTree}. Touches no network and writes nothing — it is safe to
 * call repeatedly while the user revises a selection.
 *
 * @throws if no vault is active, the connection is unknown, or the connection is
 * disabled.
 */
export function planPushForConnection(
  connectionId: string,
  deps: SyncOrchestratorDeps,
): PlannedPush {
  const vaultPath = deps.resolveVaultRoot();
  if (vaultPath === null) {
    throw new Error('No active vault; open a vault before syncing.');
  }

  const conn = deps.readConnection(vaultPath, connectionId);
  if (conn === undefined) {
    throw new Error(`Unknown connection: ${connectionId}`);
  }
  if (conn.enabled === false) {
    throw new Error(`Connection ${connectionId} is disabled`);
  }

  const items = deps.sourceCanonicalItems(vaultPath);

  // One query → a Map lookup, so planning N items costs one read, not N.
  const linksById = new Map<string, SyncLink>();
  for (const link of deps.listLinks(conn.connectionId)) {
    linksById.set(link.specItemId, link);
  }
  const resolveLink: SyncLinkResolver = (specItemId) => linksById.get(specItemId) ?? null;

  const plan = planPush(items, resolveLink);
  const preview = buildPushPreview(plan, conn.provider);
  const adapter = deps.buildAdapter(conn);

  // Use the PERSISTED connection id — never recompute it (sync_links is keyed on
  // it; recomputing would orphan every existing link).
  return {
    connectionId: conn.connectionId,
    provider: conn.provider,
    items,
    plan,
    preview,
    adapter,
  };
}

/**
 * Execute an already-planned (and approved) push — the apply half (user
 * disposes). Drives the adapter and writes a SyncLink per successful write.
 *
 * Delegates straight to {@link executePush}, which captures per-item failures
 * (including a `LinearRequestError`) into {@link PushResult} and never throws on
 * an item failure — so this never wraps it in a throw-expecting try/catch.
 */
export function executePlannedPush(
  planned: PlannedPush,
  deps: SyncOrchestratorDeps,
): Promise<PushResult> {
  return executePush(planned.plan, planned.connectionId, {
    adapter: planned.adapter,
    writeLink: deps.writeLink,
    now: deps.now,
  });
}

/**
 * Plan → approve gate → execute, in one call.
 *
 * Plans the push, hands the {@link PushPreviewTree} to `approve`, and executes
 * only if it resolves truthy. The default `approve` always approves (the
 * non-interactive path the e2e harness uses). When approval is declined the
 * plan is returned with a `null` result and nothing is executed or written.
 *
 * @returns the plan and the execution result, or `{ planned, result: null }`
 * when approval is declined.
 */
export async function runSyncPush(
  connectionId: string,
  deps: SyncOrchestratorDeps,
  approve: (preview: PushPreviewTree) => boolean | Promise<boolean> = () => true,
): Promise<{ planned: PlannedPush; result: PushResult | null }> {
  const planned = planPushForConnection(connectionId, deps);
  if (!(await approve(planned.preview))) {
    return { planned, result: null };
  }
  const result = await executePlannedPush(planned, deps);
  return { planned, result };
}

/**
 * Build the production adapter builder for a Linear connection, kept pure by
 * taking the already-bound {@link ConnectionSecrets} and
 * {@link OAuthTokenManager} as parameters (the impure store + manager are
 * injected by the deps factory in `./orchestrator-deps`).
 *
 * The credential enters only through a {@link TokenSource} wrapped in
 * {@link PatAuth}/{@link OAuthAuth}, which alone know the header shape:
 *
 *   - **PAT** — the source is the stored PAT, read on each request, so a rotated
 *     PAT is picked up without rebuilding the client.
 *   - **OAuth** — the source is `tokenManager.getAccessToken(connectionId)`, which
 *     returns a cached access token or refreshes it (and persists the rotated
 *     refresh token) on demand. The raw refresh token is NEVER wrapped directly;
 *     only the live access token reaches the `Bearer` header.
 *
 * The adapter itself is built via {@link ADAPTER_REGISTRY}, so the orchestrator
 * never `new`s a concrete adapter.
 *
 * @throws if the connection's provider has no registered adapter factory, or is
 * not the Linear provider this builder supports.
 */
export function createLinearAdapterBuilder(
  secrets: ConnectionSecrets,
  tokenManager: OAuthTokenManager,
): (conn: Connection) => IAdapter {
  return (conn: Connection): IAdapter => {
    // Validate the provider before resolving any credential or building a client,
    // so an unsupported provider fails with a clear error instead of silently
    // constructing auth/transport that will never be used.
    const factory = ADAPTER_REGISTRY[conn.provider];
    if (!factory) {
      throw new Error(`No adapter registered for provider: ${conn.provider}`);
    }
    // Only Linear is populated in the registry today, and connectionToLinearConfig
    // is Linear-specific — guard so a future provider can't slip past with a bad
    // config rather than a clear error.
    if (conn.provider !== 'linear') {
      throw new Error(`Unsupported provider for adapter builder: ${conn.provider}`);
    }

    // A PAT connection authenticates with its stored PAT, read fresh per request.
    // An OAuth connection authenticates with a live access token the token
    // manager mints/refreshes from the stored (rotating) refresh token.
    const auth =
      conn.authMode === 'oauth'
        ? new OAuthAuth(() => tokenManager.getAccessToken(conn.connectionId))
        : new PatAuth(secrets.connectionTokenSource(conn.connectionId, 'pat'));
    const client = new LinearGraphQLClient({ auth });

    const config = connectionToLinearConfig(conn);
    return factory(config, client);
  };
}

/**
 * Build an EPHEMERAL Linear GraphQL client from a raw PAT for team/project
 * discovery (TER-31) — the credential-direct counterpart to
 * {@link createLinearAdapterBuilder}.
 *
 * Discovery runs in the Settings UI *before* any persisted connection (and thus
 * any stored credential) exists, so — unlike the adapter builder, which resolves
 * the credential from the encrypted store via a `connectionId` — the PAT is
 * passed in directly and wrapped in {@link PatAuth} (the same header abstraction
 * the adapter path uses). The returned client is short-lived: the discovery
 * handler issues one query through it and discards it. The PAT is never logged,
 * persisted, or returned to the renderer.
 *
 * Kept pure (no Electron/DB/`fetch` capture beyond the client's own injectable
 * defaults) so it stays spec-importable like the rest of this module.
 */
export function buildEphemeralLinearClient(pat: string): LinearGraphQLClient {
  return new LinearGraphQLClient({ auth: new PatAuth(() => pat) });
}
