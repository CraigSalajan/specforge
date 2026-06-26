/**
 * Linear OAuth2 token-endpoint client (TER-33).
 *
 * The single HTTP layer for the three token-endpoint operations a public PKCE
 * desktop client needs:
 *
 *   - {@link LinearTokenClient.exchangeCode} — auth-code → tokens (after the
 *     loopback redirect captures the `code`).
 *   - {@link LinearTokenClient.refresh} — refresh-token → fresh tokens (Linear
 *     issues a **rotating** refresh token, so the response always carries a NEW
 *     one the caller must persist atomically).
 *   - {@link LinearTokenClient.revoke} — invalidate a token on disconnect.
 *
 * ## Electron-free & fully injectable
 * Like {@link ../client.LinearGraphQLClient}, every side-effect enters through an
 * injected `fetch` (defaulting to global `fetch`). At module scope this touches
 * no Electron, no DB, and no Node-only API beyond the pure {@link ../auth}
 * constants, so it bundles into the main process yet runs unmodified under the
 * renderer's jsdom spec runner with a fake `fetch`. The crypto/loopback/secret
 * machinery lives in sibling modules; this file is only the token HTTP.
 *
 * ## No client secret — ever
 * This is a public client: every request sends only `client_id` (resolved via
 * {@link requireOAuthClientId}) and, where applicable, the PKCE `code_verifier`.
 * A secret is never embedded or transmitted. Scopes are sent **comma-delimited**
 * (Linear's documented format), not space-delimited.
 *
 * @see ./pkce for the verifier/challenge/state generation.
 * @see ./token-manager for the cache + rotating-refresh persistence layer.
 */

import {
  LINEAR_OAUTH_REVOKE_URL,
  LINEAR_OAUTH_TOKEN_URL,
  requireOAuthClientId,
} from '../auth';

/**
 * The parsed, normalized result of a successful token exchange or refresh. Field
 * names are camelCased away from Linear's snake_case wire shape; `expiresInSec`
 * is the access token's lifetime in **seconds** (Linear returns ~86399 ≈ 24h).
 */
export interface OAuthTokenResponse {
  /** The OAuth2 access token (`Bearer` credential for GraphQL requests). */
  accessToken: string;
  /**
   * The rotating refresh token. Linear invalidates the previous refresh token on
   * every exchange (auth-code OR refresh) and returns a new one here, so this
   * value MUST be persisted immediately or the next refresh fails `invalid_grant`.
   */
  refreshToken: string;
  /** Access-token lifetime in SECONDS (Linear: ~86399). */
  expiresInSec: number;
  /** The granted scopes string echoed by Linear, if present. */
  scope?: string;
}

/**
 * Thrown when Linear responds `invalid_grant` — the authorization code expired
 * or was already used, or (more commonly) the refresh token was invalidated by a
 * prior rotation that wasn't persisted. The token manager surfaces this to the
 * UI as "reconnect required": the only recovery is a fresh authorize flow.
 */
export class OAuthReconnectRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthReconnectRequiredError';
  }
}

/** Linear's documented token-endpoint error envelope. */
interface OAuthErrorBody {
  error?: string;
  error_description?: string;
}

/** Linear's raw (snake_case) successful token-endpoint response body. */
interface OAuthTokenBody {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** Options for {@link LinearTokenClient}; the `fetch` is injectable for tests. */
export interface LinearTokenClientOptions {
  /** `fetch` implementation; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /**
   * Resolver for the OAuth `client_id`; defaults to {@link requireOAuthClientId}
   * (which throws when the build constant is unset). Injectable ONLY so tests can
   * supply a stub id without mocking the node-free `auth` constants module (which
   * the renderer client spec also imports). Production never overrides this.
   */
  resolveClientId?: () => string;
}

/** Arguments for an authorization-code exchange. */
export interface ExchangeCodeArgs {
  /** The authorization `code` captured at the loopback redirect. */
  code: string;
  /** The PKCE `code_verifier` whose challenge was sent on the authorize request. */
  codeVerifier: string;
  /** The exact `redirect_uri` used on the authorize request (Linear re-validates it). */
  redirectUri: string;
}

/**
 * Performs the Linear OAuth2 token-endpoint calls. Stateless apart from the
 * injected `fetch`; the manager above owns caching and refresh-token persistence.
 */
export class LinearTokenClient {
  private readonly fetchFn: typeof fetch;
  private readonly resolveClientId: () => string;

  constructor(options: LinearTokenClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.resolveClientId = options.resolveClientId ?? requireOAuthClientId;
  }

  /**
   * Exchanges an authorization `code` (+ PKCE verifier) for tokens. Sends
   * `grant_type=authorization_code`, `code`, `client_id`, `redirect_uri`, and
   * `code_verifier` — never a client secret. Returns the parsed
   * {@link OAuthTokenResponse}, including the first rotating refresh token.
   *
   * @throws {OAuthReconnectRequiredError} on an `invalid_grant` response.
   * @throws {Error} on any other non-2xx response or a malformed body.
   */
  async exchangeCode(args: ExchangeCodeArgs): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: args.code,
      client_id: this.resolveClientId(),
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
    });
    return this.postToken(body);
  }

  /**
   * Exchanges a refresh token for fresh tokens. Sends `grant_type=refresh_token`,
   * `refresh_token`, and `client_id` — never a client secret. The response
   * carries a NEW (rotated) refresh token the caller MUST persist immediately.
   *
   * @throws {OAuthReconnectRequiredError} on an `invalid_grant` response (the
   * stored refresh token is dead; the user must reconnect).
   * @throws {Error} on any other non-2xx response or a malformed body.
   */
  async refresh(refreshToken: string): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.resolveClientId(),
    });
    return this.postToken(body);
  }

  /**
   * Revokes a token at Linear's revocation endpoint. Sends `token` plus an
   * optional `token_type_hint`. A 200 means success; this resolves on 2xx and
   * throws on a non-2xx so a failed revoke surfaces rather than silently passing.
   */
  async revoke(token: string, hint?: 'access_token' | 'refresh_token'): Promise<void> {
    const body = new URLSearchParams({ token });
    if (hint) body.set('token_type_hint', hint);
    const res = await this.fetchFn(LINEAR_OAUTH_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`[linear] OAuth token revocation failed: HTTP ${res.status}`);
    }
  }

  /**
   * Shared token-endpoint POST: form-encodes the body, parses the JSON envelope,
   * maps `invalid_grant` to {@link OAuthReconnectRequiredError}, any other error
   * to a generic `Error`, and validates the success shape before returning it.
   */
  private async postToken(body: URLSearchParams): Promise<OAuthTokenResponse> {
    const res = await this.fetchFn(LINEAR_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const parsed = await this.readJson(res);

    if (!res.ok) {
      const err = (parsed ?? {}) as OAuthErrorBody;
      const description = err.error_description ?? `HTTP ${res.status}`;
      if (err.error === 'invalid_grant') {
        throw new OAuthReconnectRequiredError(
          `[linear] OAuth grant is no longer valid (${description}); reconnect required.`,
        );
      }
      throw new Error(
        `[linear] OAuth token request failed: ${err.error ?? 'error'} — ${description}`,
      );
    }

    return this.parseTokenBody(parsed);
  }

  /** Parses a JSON body, tolerating an unreadable/non-JSON response. */
  private async readJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  /**
   * Validates and normalizes a successful token body into
   * {@link OAuthTokenResponse}. A 2xx that lacks `access_token`/`refresh_token`
   * violates the contract and is rejected rather than returned half-formed.
   */
  private parseTokenBody(parsed: unknown): OAuthTokenResponse {
    const body = (parsed ?? {}) as OAuthTokenBody;
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new Error('[linear] OAuth token response missing access_token.');
    }
    if (typeof body.refresh_token !== 'string' || body.refresh_token.length === 0) {
      throw new Error('[linear] OAuth token response missing refresh_token.');
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresInSec: typeof body.expires_in === 'number' ? body.expires_in : 0,
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
    };
  }
}
