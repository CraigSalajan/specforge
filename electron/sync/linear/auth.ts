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
 * Registered Linear OAuth application client_id (TER-33). This is a **public**
 * desktop PKCE client, so there is intentionally no client secret embedded
 * anywhere — PKCE proves possession of the authorization request instead.
 *
 * Hardcoded as a build constant (the config decision for TER-33): the value is
 * not secret, identical for every install, and an empty default keeps the app
 * compilable before the real app is registered. {@link requireOAuthClientId}
 * turns the blank default into a clear, actionable error at connect/refresh time.
 */
// Registered SpecForge Linear OAuth app client_id (public PKCE client — not secret; identical for every install).
export const LINEAR_OAUTH_CLIENT_ID = 'b0a3a64d2af13f34e2858918d0a00f1d';

/**
 * Loopback port the OAuth redirect listens on. The redirect URI below MUST be
 * registered verbatim (including this port) in the Linear OAuth app — Linear
 * matches it exactly, so it cannot be chosen dynamically at runtime.
 */
export const LINEAR_OAUTH_REDIRECT_PORT = 53217;

/**
 * Loopback redirect URI for the authorization-code flow. Must match a
 * pre-registered redirect URI on the Linear OAuth app **exactly** (scheme, host,
 * port, and path), or Linear rejects the authorize request. `127.0.0.1` (not
 * `localhost`) is used deliberately so the registered value is unambiguous.
 */
export const LINEAR_OAUTH_REDIRECT_URI = `http://127.0.0.1:${LINEAR_OAUTH_REDIRECT_PORT}/callback`;

/**
 * Returns the configured OAuth client_id, throwing a clear, actionable error
 * when it is still the empty default. The connect/refresh flows call this up
 * front so a missing registration fails loudly here rather than surfacing as a
 * confusing HTTP 400 from Linear's token endpoint.
 *
 * @throws if {@link LINEAR_OAUTH_CLIENT_ID} is blank.
 */
export function requireOAuthClientId(): string {
  const clientId = LINEAR_OAUTH_CLIENT_ID.trim();
  if (clientId.length === 0) {
    throw new Error(
      '[linear] OAuth is not configured: LINEAR_OAUTH_CLIENT_ID is empty. Register a Linear OAuth app and set the client_id constant.',
    );
  }
  return clientId;
}

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
 * OAuth2 access-token authentication.
 *
 * Surfaces a live OAuth2 access token as `Authorization: Bearer <token>`,
 * resolved lazily through the injected {@link TokenSource}. The source is
 * responsible for returning a current, valid token; in production, the injected
 * source is `() => tokenManager.getAccessToken(connectionId)`, which refreshes
 * automatically before the 24-hour expiry.
 *
 * The full authorization-code + PKCE + token-exchange + refresh + revocation
 * machinery is implemented in sibling modules:
 *   - `electron/sync/linear/oauth/pkce.ts` — PKCE verifier/challenge generation
 *   - `electron/sync/linear/oauth/token-client.ts` — HTTP calls to Linear's token endpoints
 *   - `electron/sync/linear/oauth/token-manager.ts` — maintains and auto-refreshes tokens
 *   - `electron/ipc/linear-oauth.ts` — IPC shim bridging the renderer to token management
 *
 * The {@link authorizationHeader} method resolves the token via the source and
 * returns the properly-formatted bearer token; the actual acquisition and refresh
 * are driven by the IPC connect flow, not by this class.
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
   * Retained as an explicit, throwing marker. The real token acquisition and refresh
   * are driven by the IPC connect flow (via `electron/ipc/linear-oauth.ts`) and managed
   * by the token manager, not by this method. This method exists to clearly signal that
   * OAuth token management is handled elsewhere in the system.
   */
  static async acquireToken(): Promise<never> {
    throw new Error(
      '[linear] OAuth token acquisition is not implemented yet; supply an access token via the injected source.',
    );
  }
}
