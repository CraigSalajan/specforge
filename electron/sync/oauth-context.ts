/**
 * Shared OAuth runtime context (TER-33) — main-only.
 *
 * The OAuth access-token manager holds per-process in-memory state (the access
 * cache + the in-flight refresh dedupe map) and writes the rotating refresh
 * token to the encrypted secret store. Two consumers must observe the SAME
 * instance or the cache + rotation guarantees break:
 *
 *   1. the sync orchestrator's adapter builder (mints `Bearer` tokens for pushes), and
 *   2. the OAuth IPC handlers (seed the cache + persist the refresh token on connect,
 *      and revoke on disconnect).
 *
 * This module owns that single shared instance (built lazily, once) plus the
 * single {@link ConnectionSecrets} both sides write through, so a connect's
 * seeded refresh token and a later push's refresh observe one consistent store
 * and cache. It imports the SQLite-backed secret store, so it is main-only and
 * is NEVER imported by any spec.
 *
 * @see ./linear/oauth/token-manager for the cache + rotating-refresh logic.
 */

import { createConnectionSecrets, type ConnectionSecrets } from './connection-secrets';
import {
  createOAuthTokenManager,
  type OAuthTokenManager,
} from './linear/oauth/token-manager';
import { LinearTokenClient } from './linear/oauth/token-client';
import { secretSettingsStore } from '../ipc/settings-secret-store';

/** The shared collaborators every OAuth-aware seam binds against. */
export interface OAuthRuntimeContext {
  /** The encrypted per-connection secret store (refresh-token home). */
  secrets: ConnectionSecrets;
  /** The token-endpoint HTTP client (exchange/refresh/revoke). */
  tokenClient: LinearTokenClient;
  /** The shared access-token manager (cache + rotating-refresh persistence). */
  tokenManager: OAuthTokenManager;
}

let shared: OAuthRuntimeContext | null = null;

/**
 * Returns the process-wide {@link OAuthRuntimeContext}, constructing it once on
 * first call. Both the orchestrator deps and the OAuth IPC handlers call this so
 * they share one secrets store + token manager (and therefore one cache).
 */
export function getOAuthRuntimeContext(): OAuthRuntimeContext {
  if (shared === null) {
    const secrets = createConnectionSecrets(secretSettingsStore);
    const tokenClient = new LinearTokenClient();
    const tokenManager = createOAuthTokenManager({ secrets, tokenClient, now: Date.now });
    shared = { secrets, tokenClient, tokenManager };
  }
  return shared;
}
