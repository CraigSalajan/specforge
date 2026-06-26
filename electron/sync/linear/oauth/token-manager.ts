/**
 * OAuth access-token manager (TER-33) — the cache + rotating-refresh layer
 * between the persisted refresh token and the GraphQL client's `Bearer` header.
 *
 * ## What is (and isn't) persisted
 * Only the **refresh token** is persisted (encrypted, via the injected
 * {@link ConnectionSecrets}). Access tokens and their expiry are deliberately
 * NOT persisted — they live only in this manager's in-memory map and are
 * re-minted from the refresh token after a restart. So the at-rest surface stays
 * exactly the one secret the connection-secrets store already models.
 *
 * ## Rotating refresh tokens (the load-bearing rule)
 * Linear rotates the refresh token on EVERY exchange: each refresh invalidates
 * the previous refresh token and returns a new one. {@link getAccessToken}
 * therefore writes the rotated refresh token back through `secrets.setConnectionToken`
 * **immediately** after a successful refresh — before returning the access token
 * — so the next refresh uses the live token and not a dead one (which would fail
 * `invalid_grant`).
 *
 * ## Concurrency
 * Two parallel pushes for the same connection must not both refresh, or the
 * second rotation invalidates the first's freshly-stored token. An in-flight
 * `Promise` map dedupes concurrent refreshes per `connectionId` so exactly one
 * network refresh happens and both callers await the same rotation.
 *
 * ## Electron-free & injectable
 * `secrets`, `tokenClient`, and `now` are all injected, so this module imports no
 * Electron/DB/`node:*` API and is exercised directly under the renderer's jsdom
 * spec runner with in-memory fakes.
 *
 * @see ./token-client for the token-endpoint HTTP.
 * @see ../../connection-secrets for the encrypted refresh-token store.
 */

import type { ConnectionSecrets } from '../../connection-secrets';
import {
  OAuthReconnectRequiredError,
  type LinearTokenClient,
  type OAuthTokenResponse,
} from './token-client';

/**
 * Refresh skew: refresh this many ms BEFORE the access token actually expires,
 * so a request never goes out with a token about to lapse mid-flight.
 */
export const REFRESH_SKEW_MS = 60_000;

/** A cached access token plus the absolute epoch ms at which it expires. */
interface CachedAccess {
  accessToken: string;
  expiresAtMs: number;
}

/** Dependencies for {@link createOAuthTokenManager}. */
export interface OAuthTokenManagerDeps {
  /** The encrypted per-connection secret store (refresh token home). */
  secrets: ConnectionSecrets;
  /** The token-endpoint HTTP client (exchange/refresh/revoke). */
  tokenClient: LinearTokenClient;
  /** Current epoch ms; injectable for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** The manager surface the orchestrator and OAuth IPC handlers consume. */
export interface OAuthTokenManager {
  /**
   * Returns a currently-valid access token for `connectionId`, refreshing from
   * the stored refresh token (and persisting the rotated one) when the cache is
   * empty or within the refresh skew of expiry.
   *
   * @throws {OAuthReconnectRequiredError} when no refresh token is stored or the
   * refresh fails `invalid_grant`.
   */
  getAccessToken(connectionId: string): Promise<string>;
  /**
   * Seeds the cache + persists the refresh token from a fresh exchange response
   * (used at the end of the connect flow, so the first push doesn't immediately
   * re-refresh).
   */
  seedFromExchange(connectionId: string, tokenResponse: OAuthTokenResponse): void;
  /**
   * Revokes the stored refresh token at Linear and drops the in-memory cache
   * entry. The persisted secret itself is cleared by the existing disconnect
   * path; this ensures the live cache never outlives a disconnect.
   */
  revoke(connectionId: string): Promise<void>;
}

/**
 * Builds an {@link OAuthTokenManager} over the injected dependencies. The
 * returned object closes over per-process in-memory state (the access-token
 * cache and the in-flight refresh map), so production should construct it ONCE
 * and share that single instance between the orchestrator's adapter builder and
 * the OAuth IPC handlers (see `./orchestrator-deps`).
 */
export function createOAuthTokenManager(deps: OAuthTokenManagerDeps): OAuthTokenManager {
  const now = deps.now ?? Date.now;
  /** connectionId → cached access token + expiry (never persisted). */
  const cache = new Map<string, CachedAccess>();
  /** connectionId → in-flight refresh, so concurrent calls share one rotation. */
  const inFlight = new Map<string, Promise<string>>();

  /** True when a cached entry is still safely valid (outside the refresh skew). */
  function isFresh(entry: CachedAccess | undefined): entry is CachedAccess {
    return entry !== undefined && entry.expiresAtMs - REFRESH_SKEW_MS > now();
  }

  /** Stores the access token + computed expiry from a token response. */
  function cacheFromResponse(connectionId: string, res: OAuthTokenResponse): void {
    // expires_in is in SECONDS; convert to an absolute epoch-ms deadline.
    cache.set(connectionId, {
      accessToken: res.accessToken,
      expiresAtMs: now() + res.expiresInSec * 1000,
    });
  }

  /**
   * Refreshes from the stored refresh token, persists the rotated refresh token
   * BEFORE returning, caches the new access token, and yields it. Wrapped by
   * {@link getAccessToken}'s dedupe so only one of these runs at a time per id.
   */
  async function doRefresh(connectionId: string): Promise<string> {
    const refreshToken = deps.secrets.getConnectionToken(connectionId, 'refreshToken');
    if (refreshToken.length === 0) {
      throw new OAuthReconnectRequiredError(
        `[linear] No refresh token stored for connection ${connectionId}; reconnect required.`,
      );
    }

    // Propagates OAuthReconnectRequiredError on invalid_grant unchanged.
    const res = await deps.tokenClient.refresh(refreshToken);

    // Persist the ROTATED refresh token immediately — before returning — so the
    // next refresh uses the live token, not the one Linear just invalidated.
    deps.secrets.setConnectionToken(connectionId, 'refreshToken', res.refreshToken);
    cacheFromResponse(connectionId, res);
    return res.accessToken;
  }

  return {
    async getAccessToken(connectionId: string): Promise<string> {
      const cached = cache.get(connectionId);
      if (isFresh(cached)) return cached.accessToken;

      // Dedupe: if a refresh for this id is already running, await it rather than
      // starting a second one (which would rotate the refresh token twice and
      // invalidate the first rotation's freshly-stored value).
      const pending = inFlight.get(connectionId);
      if (pending) return pending;

      const refreshPromise = doRefresh(connectionId).finally(() => {
        inFlight.delete(connectionId);
      });
      inFlight.set(connectionId, refreshPromise);
      return refreshPromise;
    },

    seedFromExchange(connectionId: string, tokenResponse: OAuthTokenResponse): void {
      deps.secrets.setConnectionToken(connectionId, 'refreshToken', tokenResponse.refreshToken);
      cacheFromResponse(connectionId, tokenResponse);
    },

    async revoke(connectionId: string): Promise<void> {
      const refreshToken = deps.secrets.getConnectionToken(connectionId, 'refreshToken');
      // Drop the cache entry regardless of whether a token is present, so a
      // disconnect never leaves a live access token cached.
      cache.delete(connectionId);
      inFlight.delete(connectionId);
      if (refreshToken.length === 0) return;
      await deps.tokenClient.revoke(refreshToken, 'refresh_token');
    },
  };
}
