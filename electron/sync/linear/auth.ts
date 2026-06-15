/**
 * Linear authentication abstraction for the GraphQL transport (TER-15).
 *
 * Linear supports two credential kinds that differ ONLY in how the
 * `Authorization` header is shaped:
 *
 *   - Personal API key (PAT): the header carries the RAW token, with **no**
 *     `Bearer` prefix — e.g. `Authorization: lin_api_abc123`.
 *   - OAuth2 access token: the header is `Authorization: Bearer <token>`.
 *
 * The {@link LinearAuth} interface exists precisely to hide that single
 * difference from {@link LinearGraphQLClient}: the client only ever asks for a
 * fully-formed header value and never has to know which credential kind backs
 * it. This is what lets the same `request<T>()` path serve both auth modes and
 * keeps the future `LinearAdapter` (TER-14) agnostic to credential plumbing.
 *
 * ## DB-free and Electron-free by construction
 * Neither implementation touches `electron`, `safeStorage`, settings, or any
 * Node API. The token is always supplied through an *injected* source function,
 * so this module bundles into the main process yet still runs unmodified under
 * the renderer's jsdom test runner. Production code is responsible for reading
 * the encrypted `linear.pat` setting (decrypted at the settings IPC boundary)
 * and handing the plaintext value in via that source — the auth layer never
 * reaches for it itself.
 */

/**
 * A source of the credential token. Sync, async, or a freshly-fetched value —
 * the client always `await`s it, so an implementation backed by a cache or a
 * token refresh is transparent to callers.
 */
export type TokenSource = () => string | Promise<string>;

/**
 * Produces the full `Authorization` header value for a Linear API request.
 *
 * Returning the *complete* header value (not just the token) is deliberate: it
 * is the one place that encodes the PAT-vs-OAuth shape difference, so the client
 * can stay oblivious. Implementations resolve the token lazily on each request
 * so a rotated PAT or refreshed OAuth token is picked up without rebuilding the
 * client.
 */
export interface LinearAuth {
  /**
   * @returns the value to place in the `Authorization` header — the raw token
   * for a PAT, or `Bearer <token>` for an OAuth2 access token.
   * @throws if no usable token is available (e.g. an empty/unset PAT).
   */
  authorizationHeader(): Promise<string>;
}

/** Shared guard so both auth kinds reject blank tokens identically. */
function requireToken(token: string, label: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new Error(`[linear] ${label} is empty; cannot authenticate the request.`);
  }
  return trimmed;
}

/**
 * Personal API key authentication.
 *
 * Linear's documented contract for a Personal API key is that the `Authorization`
 * header is the **raw token** with NO `Bearer` prefix. Sending `Bearer <pat>`
 * fails auth, so this implementation returns the token verbatim.
 */
export class PatAuth implements LinearAuth {
  /**
   * @param tokenSource resolves the Personal API key. Injected so the auth
   * layer never reads settings/`safeStorage` directly (production wires this to
   * the decrypted `linear.pat` setting; tests pass a constant).
   */
  constructor(private readonly tokenSource: TokenSource) {}

  async authorizationHeader(): Promise<string> {
    const token = await this.tokenSource();
    // RAW token — Linear PATs are sent with no scheme prefix.
    return requireToken(token, 'Personal API key');
  }
}

// --- OAuth2 (production stub) -------------------------------------------------

/**
 * Linear OAuth2 authorization endpoint — where the user grants access and the
 * app receives an authorization `code` (with PKCE).
 */
export const LINEAR_OAUTH_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';

/** Linear OAuth2 token endpoint — exchanges the code (or a refresh token) for an access token. */
export const LINEAR_OAUTH_TOKEN_URL = 'https://api.linear.app/oauth/token';

/** Linear OAuth2 revocation endpoint — invalidates an access/refresh token. */
export const LINEAR_OAUTH_REVOKE_URL = 'https://api.linear.app/oauth/revoke';

/** PKCE code-challenge method Linear requires for public (desktop) clients. */
export const LINEAR_OAUTH_PKCE_METHOD = 'S256' as const;

/**
 * Lifetime of a Linear OAuth2 access token (24 hours). The full flow must
 * refresh before this elapses; see the {@link OAuthAuth} TODO.
 */
export const LINEAR_OAUTH_ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * OAuth scopes SpecForge may request. `read`/`write` are the coarse grants;
 * the `*:create` scopes are finer-grained write capabilities; `admin` is the
 * superset (requested only when strictly required).
 */
export const LINEAR_OAUTH_SCOPES = [
  'read',
  'write',
  'issues:create',
  'comments:create',
  'admin',
] as const;

/**
 * OAuth2 access-token authentication — **production stub**.
 *
 * The header shape is final and correct (`Bearer <token>`), so this class is a
 * drop-in for {@link PatAuth} via the shared {@link LinearAuth} interface today.
 * What is NOT implemented yet is the token *acquisition / refresh* machinery,
 * which the constants above document for the eventual full flow:
 *
 *   1. Build an authorization URL at {@link LINEAR_OAUTH_AUTHORIZE_URL} with a
 *      PKCE challenge ({@link LINEAR_OAUTH_PKCE_METHOD} = S256) and the desired
 *      {@link LINEAR_OAUTH_SCOPES}; open it in the user's browser.
 *   2. Exchange the returned `code` + PKCE verifier at
 *      {@link LINEAR_OAUTH_TOKEN_URL} for an access token (lifetime
 *      {@link LINEAR_OAUTH_ACCESS_TOKEN_TTL_MS}) and a refresh token.
 *   3. Refresh via {@link LINEAR_OAUTH_TOKEN_URL} before the access token
 *      expires; revoke via {@link LINEAR_OAUTH_REVOKE_URL} on disconnect.
 *
 * Until that lands, this class simply surfaces an externally-acquired access
 * token supplied through the injected source — the refresh/acquire path is a
 * documented TODO, not silently faked.
 */
export class OAuthAuth implements LinearAuth {
  /**
   * @param accessTokenSource resolves a currently-valid OAuth2 access token.
   * Injected for the same DB-/Electron-free reasons as {@link PatAuth}.
   */
  constructor(private readonly accessTokenSource: TokenSource) {}

  async authorizationHeader(): Promise<string> {
    // TODO(TER-OAuth): wire the real authorize → token → refresh flow described
    // in the class docblock. For now we trust the injected source to hand us a
    // live access token; we do not attempt to acquire or refresh one here.
    const token = await this.accessTokenSource();
    return `Bearer ${requireToken(token, 'OAuth access token')}`;
  }

  /**
   * Acquire a fresh access token via the OAuth2 authorization-code + PKCE flow.
   *
   * Not implemented — see the class docblock for the steps and endpoints. The
   * method exists so the production wiring point is explicit rather than absent.
   */
  static async acquireToken(): Promise<never> {
    throw new Error(
      '[linear] OAuth token acquisition is not implemented yet; supply an access token via the injected source.',
    );
  }
}
