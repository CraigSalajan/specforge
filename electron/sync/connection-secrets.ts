/**
 * Main-process store for per-connection PM credentials — the encrypted-secret
 * counterpart to the non-secret {@link ./connection-store} read API.
 *
 * A {@link ./connection Connection} carries only the non-secret *where*
 * (team/project target) and the `authMode` discriminator; the token itself is
 * deliberately absent there (TER-28). This module is that token's home: it keys
 * each credential by `connectionId` — which already hashes the normalized vault
 * path + provider + team/project (see {@link ./connection.makeConnectionId}) —
 * so a stored secret is inherently per-vault with no cross-vault leakage.
 *
 * Secrets travel the same at-rest encryption seam as the bare `linear.pat`
 * setting: {@link encryptSettingValue}/{@link decryptSettingValue} from
 * `../ipc/secure-settings` gate on {@link isSecretSettingKey}, which recognizes
 * the `linear.pat::`/`linear.refreshToken::` prefixes this module writes. The
 * underlying repo has no delete; an unset secret is the empty string, so
 * clearing a credential writes `''` (empty values pass through unencrypted).
 *
 * This module is intentionally main-only (it imports the DB repo and the
 * Electron `safeStorage`-backed transforms). The credential never crosses to
 * the renderer: `settings:get-all` skips {@link isConnectionSecretKey} rows, and
 * the only renderer-facing surface is a boolean *status* (TER-28 IPC handlers).
 *
 * @see ./connection-store for the non-secret connection read API.
 * @see ../ipc/secure-settings for the at-rest encryption transforms.
 */

import { getSetting, setSetting } from '../db/repositories/settings.repo';
import { decryptSettingValue, encryptSettingValue } from '../ipc/secure-settings';
import type { TokenSource } from './linear/auth';

/** Which credential a per-connection secret holds: a PAT or an OAuth refresh token. */
export type ConnectionSecretKind = 'pat' | 'refreshToken';

/**
 * Builds the settings key for a connection's credential. `kind: 'pat'` →
 * `linear.pat::<connectionId>`, `kind: 'refreshToken'` →
 * `linear.refreshToken::<connectionId>` — matching the
 * `CONNECTION_SECRET_PREFIXES` recognized by `../ipc/secure-settings`, so the
 * value is encrypted at rest and never hydrated into the renderer.
 */
export function connectionSecretKey(connectionId: string, kind: ConnectionSecretKind): string {
  // `kind` is already the exact key segment (`pat` | `refreshToken`).
  return `linear.${kind}::${connectionId}`;
}

/**
 * Reads and decrypts a connection's stored credential, or `''` when it is unset
 * or fails to decrypt — the same "treat as unset" posture as
 * {@link decryptSettingValue}, so a corrupt row never throws into the sync path.
 */
export function getConnectionToken(connectionId: string, kind: ConnectionSecretKind): string {
  const key = connectionSecretKey(connectionId, kind);
  const stored = getSetting(key);
  if (stored === null) return '';
  return decryptSettingValue(key, stored);
}

/**
 * Encrypts and persists a connection's credential. Passing `token === ''` clears
 * the row (the empty value passes through unencrypted — there is no delete in
 * the underlying K/V repo, so empty is "unset").
 */
export function setConnectionToken(
  connectionId: string,
  kind: ConnectionSecretKind,
  token: string,
): void {
  const key = connectionSecretKey(connectionId, kind);
  setSetting(key, encryptSettingValue(key, token));
}

/** True when a non-empty credential of `kind` is stored for `connectionId`. */
export function hasConnectionToken(connectionId: string, kind: ConnectionSecretKind): boolean {
  return getConnectionToken(connectionId, kind).length > 0;
}

/**
 * Clears BOTH the PAT and the refresh token for `connectionId` (each written as
 * `''`). Called when a connection is removed so credentials are never orphaned.
 */
export function deleteConnectionSecrets(connectionId: string): void {
  setConnectionToken(connectionId, 'pat', '');
  setConnectionToken(connectionId, 'refreshToken', '');
}

/**
 * Produces a {@link TokenSource} bound to a connection's credential — the exact
 * shape `PatAuth`/`OAuthAuth` consume. Each call resolves the *current* stored
 * value, so a rotated credential is picked up without rebuilding the auth layer.
 */
export function connectionTokenSource(
  connectionId: string,
  kind: ConnectionSecretKind = 'pat',
): TokenSource {
  return () => getConnectionToken(connectionId, kind);
}
