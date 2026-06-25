/**
 * PM connection model — the persisted, per-vault description of *where* SpecForge
 * syncs to (target/config), deliberately *without* the credential.
 *
 * ## Why this module is dependency-free
 * This file is imported from **both** the Electron main process (the sync
 * orchestrator, the {@link ./connection-store} read API) and the Angular
 * renderer (the settings UI, via `settings.service.ts`). It must therefore stay
 * free of any Node-only import — notably it does NOT import `node:crypto` or
 * `electron/util/hash.ts`, because either would make the module main-only and
 * either break the renderer's cross-tree `import type` use or force a new IPC
 * channel just to compute an id. The id generator below is a small pure
 * deterministic hash (FNV-1a) precisely so it can run identically on both sides.
 *
 * ## Head/tail shape
 * A {@link Connection} is a discriminated union on `provider`. The shared
 * {@link ConnectionBase} *head* (`connectionId`, `provider`, `enabled`,
 * `authMode`) is common to every provider; the per-provider *tail*
 * ({@link LinearConnection}'s `teamId`/`projectId`/`featureLabelId`) carries the
 * provider-native target fields. Only Linear exists in V1, but the union is open
 * for future providers (Jira/ADO/GitHub) — add a `XyzConnection extends
 * ConnectionBase { provider: 'xyz'; … }` and widen {@link Connection}.
 *
 * ## Credentials are deliberately absent (TER-28)
 * A connection carries only the non-secret *where* (team/project target) and the
 * `authMode` *discriminator* — never the token itself. Credentials are persisted
 * separately through the encrypted IPC path in TER-28; this keeps the connection
 * model safe to store in the plain settings JSON and safe to round-trip through
 * the renderer.
 *
 * @see ./adapter for the provider-agnostic {@link AdapterName} union.
 * @see ./linear/linear-adapter for {@link LinearConnectionConfig}, the adapter's
 * runtime target this maps onto via {@link connectionToLinearConfig}.
 */

import type { AdapterName } from './adapter';
import type { LinearConnectionConfig } from './linear/linear-adapter';

/**
 * How a connection authenticates to its provider: a Personal Access Token
 * (`pat`) or an OAuth-issued token (`oauth`). Stored as the *discriminator*
 * only — the secret material lives elsewhere (TER-28).
 */
export type AuthMode = 'pat' | 'oauth';

/**
 * Fields common to every provider's connection (the union *head*). The
 * per-provider tail (e.g. {@link LinearConnection}) extends this with the
 * provider-native target fields.
 */
export interface ConnectionBase {
  /**
   * Stable, persisted identifier for this connection. Computed once at creation
   * via {@link makeConnectionId} and stored verbatim — see that function's note
   * on why it must never be recomputed on read.
   */
  connectionId: string;
  /** Which PM provider this connection targets (the union discriminant). */
  provider: AdapterName;
  /** Whether the sync orchestrator should consider this connection active. */
  enabled: boolean;
  /** How the connection authenticates (the secret itself is stored separately). */
  authMode: AuthMode;
}

/**
 * A connection targeting a Linear workspace. The tail mirrors
 * {@link LinearConnectionConfig}: a required `teamId` (the team that owns the
 * issues) plus the optional `projectId` (group issues under a project) and
 * `featureLabelId` (label applied to `feature`-level items). The credential is
 * absent here exactly as it is in {@link LinearConnectionConfig}.
 */
export interface LinearConnection extends ConnectionBase {
  provider: 'linear';
  /** Linear team id that owns the created issues. */
  teamId: string;
  /** Optional Linear project id to group created issues under. */
  projectId?: string;
  /** Optional Linear label id applied to created Features (level === 'feature'). */
  featureLabelId?: string;
}

/**
 * The persisted connection union, discriminated on `provider`. Only
 * {@link LinearConnection} exists in V1; widen this union as future providers
 * (Jira/ADO/GitHub) land.
 */
export type Connection = LinearConnection;

/**
 * The minimal inputs that determine a connection's identity. Two connections
 * with the same `vaultPath` + `provider` + `projectId` are considered the same
 * target and so share an id; differing on any of these yields a distinct id.
 */
export interface ConnectionIdInput {
  /** Absolute vault path the connection belongs to (normalized before hashing). */
  vaultPath: string;
  /** The PM provider this connection targets. */
  provider: AdapterName;
  /** Optional provider project id; part of the identity so two projects differ. */
  projectId?: string;
}

/**
 * 32-bit FNV-1a hash of a string, returned as the unsigned integer hash value.
 * Pure and deterministic with no platform dependency — the reason this module
 * can run identically in the main process and the renderer (see the file
 * header). Not a cryptographic hash; it exists only to derive a short, stable id
 * over a tiny per-vault namespace where collision risk is negligible.
 */
function fnv1a32(input: string): number {
  // FNV-1a: offset basis 2166136261, prime 16777619; `>>> 0` keeps each step
  // in unsigned 32-bit space (Math.imul gives the 32-bit multiply).
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Derives the **stable** id for a connection from its identity inputs.
 *
 * The vault path is normalized to *lowercase, forward-slash* before hashing —
 * the same normalization the `ui.collapsedFolders` setting documents ("Normalized
 * (lowercase, forward-slash) vault-relative paths") — so `C:\Vault` and
 * `c:/vault` resolve to the same connection. The composite key is
 * `${normalizedVault}|${provider}|${projectId ?? ''}`, and the result is
 * `${provider}-${hashHex}`, where `hashHex` is 16 lowercase hex chars: two
 * FNV-1a passes (the second salted) concatenated to widen the space from 32 to
 * 64 bits and further shrink collision odds.
 *
 * IMPORTANT — the id MUST be computed once at creation and persisted verbatim,
 * never recomputed on read. `sync_links` enforces `UNIQUE(spec_item_id,
 * connection_id)`, so a changed `connectionId` would orphan every existing
 * SyncLink that referenced the old id (the item would re-create remotely instead
 * of updating). Recomputing on read is therefore a correctness hazard, not just
 * an inefficiency. Collision risk across the small per-vault connection namespace
 * is negligible.
 */
export function makeConnectionId(input: ConnectionIdInput): string {
  // Same "normalized lowercase, forward-slash" precedent as ui.collapsedFolders.
  const normalizedVault = input.vaultPath.replace(/\\/g, '/').toLowerCase();
  const key = `${normalizedVault}|${input.provider}|${input.projectId ?? ''}`;

  const lo = fnv1a32(key);
  // A salted second pass widens the digest to 64 bits (16 hex) so the id space
  // is comfortably larger than the per-vault namespace it labels.
  const hi = fnv1a32(`${key}|fnv-salt`);
  const hashHex = lo.toString(16).padStart(8, '0') + hi.toString(16).padStart(8, '0');

  return `${input.provider}-${hashHex}`;
}

/**
 * Maps a {@link LinearConnection} onto the adapter's runtime
 * {@link LinearConnectionConfig}. This is the seam the sync orchestrator
 * (TER-29) calls to build the config it passes to
 * `ADAPTER_REGISTRY.linear(config, client)` — the connection is the *persisted*
 * target, the config is the *runtime* target the adapter consumes.
 *
 * `teamId` is always emitted; `projectId`/`featureLabelId` are included only when
 * defined so the resulting object never carries explicit `undefined` keys (which
 * would differ from an omitted optional under strict checks and serialization).
 */
export function connectionToLinearConfig(conn: LinearConnection): LinearConnectionConfig {
  const config: LinearConnectionConfig = { teamId: conn.teamId };
  if (conn.projectId !== undefined) config.projectId = conn.projectId;
  if (conn.featureLabelId !== undefined) config.featureLabelId = conn.featureLabelId;
  return config;
}

/**
 * Type guard validating a single stored {@link Connection}. Defensive in the
 * same spirit as `isDisabledLocalMap` in `settings.service.ts`: any malformed
 * persisted value is rejected rather than trusted into the typed model. Only the
 * `'linear'` provider is recognized in V1; widen alongside {@link Connection}.
 */
export function isConnection(value: unknown): value is Connection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['connectionId'] !== 'string') return false;
  if (v['provider'] !== 'linear') return false;
  if (typeof v['enabled'] !== 'boolean') return false;
  if (v['authMode'] !== 'pat' && v['authMode'] !== 'oauth') return false;
  if (typeof v['teamId'] !== 'string') return false;
  // Optional fields must be absent or a string — never some other type.
  if (v['projectId'] !== undefined && typeof v['projectId'] !== 'string') return false;
  if (v['featureLabelId'] !== undefined && typeof v['featureLabelId'] !== 'string') return false;
  return true;
}

/**
 * Validates and normalizes a parsed `pm.connections` value: a record mapping
 * vault path strings to arrays of {@link Connection}. Mirrors the defensive
 * style of `isDisabledLocalMap`: a non-object/array top-level value yields `{}`,
 * each vault entry keeps only the connections that pass {@link isConnection},
 * and a vault key is dropped entirely when no valid connection remains for it.
 * The result is always a well-typed map safe to store back.
 */
export function parseConnectionsMap(value: unknown): Record<string, Connection[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, Connection[]> = {};
  for (const [vaultPath, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const valid = list.filter(isConnection);
    if (valid.length > 0) out[vaultPath] = valid;
  }
  return out;
}
