/**
 * Linear OAuth2 authorization-code + PKCE flow — IPC seam (TER-33).
 *
 * This is the electron/node-heavy half of the OAuth feature: it opens the system
 * browser at Linear's authorize URL, runs a one-shot loopback HTTP server to
 * capture the redirect, exchanges the code for tokens, discovers teams/projects
 * with an OAuth-backed GraphQL client, and finally moves the rotating refresh
 * token into the encrypted store under the chosen `connectionId`.
 *
 * ## Why the tokens never cross to the renderer
 * The browser flow yields an access token + refresh token main-side. They are
 * held only in an in-memory **pending session** keyed by an opaque `sessionId`;
 * the renderer receives ONLY that `sessionId` plus the non-secret team/project
 * lists (the exact shapes the PAT discovery returns, so the Settings picker is
 * reused verbatim). On `complete`, the refresh token is persisted under the
 * connection's id and seeded into the shared token-manager cache; the pending
 * session is dropped. No token value is ever returned over IPC.
 *
 * ## Testability seam
 * The crypto, token HTTP, and cache/rotation logic all live in the pure
 * `../sync/linear/oauth/*` modules (unit-tested under jsdom). This module is the
 * thin, impure orchestration shim — `electron`, `node:http`, and the loopback
 * server — so it is main-only and is never imported by a spec.
 *
 * @see ../sync/linear/oauth/pkce, token-client, token-manager for the pure pieces.
 * @see ./shell for the validated `openExternal` this reuses to launch the browser.
 */

import { ipcMain } from 'electron';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  LINEAR_OAUTH_AUTHORIZE_URL,
  LINEAR_OAUTH_PKCE_METHOD,
  LINEAR_OAUTH_REDIRECT_PORT,
  LINEAR_OAUTH_REDIRECT_URI,
  LINEAR_OAUTH_SCOPES,
  OAuthAuth,
  requireOAuthClientId,
} from '../sync/linear/auth';
import {
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '../sync/linear/oauth/pkce';
import { LinearGraphQLClient } from '../sync/linear/client';
import { discoverProjects, discoverTeams } from '../sync/linear/discovery';
import { handleOpenExternal } from './shell';
import { LinearRequestError } from '../sync/linear/errors';
import type { OAuthRuntimeContext } from '../sync/oauth-context';
import type { OAuthTokenResponse } from '../sync/linear/oauth/token-client';
import type { AiErrorInfo } from './ai-error';
import type { LinearProject, LinearTeam } from '../sync/adapter';

/** Max time the user has to complete the browser authorization before we give up. */
const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long a captured-but-unbound {@link PendingSession} (live access + refresh
 * tokens, held in memory only) is allowed to live before it is evicted. Bounds
 * the window in which an abandoned authorization — the user closes the modal
 * without saving — keeps usable tokens resident in the main process. The user
 * has from `begin` to `complete` (pick a team + Save) within this window;
 * otherwise the session is dropped and they reauthorize.
 */
const PENDING_SESSION_TTL_MS = 10 * 60 * 1000;

const Channels = {
  Begin: 'specforge:linear-oauth-begin',
  ListProjects: 'specforge:linear-oauth-list-projects',
  Complete: 'specforge:linear-oauth-complete',
  Revoke: 'specforge:linear-oauth-revoke',
} as const;

/**
 * Tokens captured by the browser flow but not yet bound to a connection. Held in
 * memory only, keyed by an opaque `sessionId`; never persisted until `complete`.
 * The `evictTimer` drops the session — and therefore these live tokens — once
 * {@link PENDING_SESSION_TTL_MS} elapses without a `complete`.
 */
interface PendingSession {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  /** Timer that evicts this session (and its in-memory tokens) on TTL expiry. */
  evictTimer: ReturnType<typeof setTimeout>;
}

/** Result of a single loopback authorization capture. */
interface CapturedCode {
  code: string;
}

/** Begin result returned to the renderer — `sessionId` + non-secret teams. */
export interface LinearOAuthBeginResult {
  sessionId: string;
  teams: LinearTeam[];
}

/** Envelope for {@link handleBegin}: failures travel as data, like the sync handlers. */
export type LinearOAuthBeginEnvelope =
  | { ok: true; data: LinearOAuthBeginResult }
  | { ok: false; error: AiErrorInfo };

/** Envelope for {@link handleListProjects}. */
export type LinearOAuthListProjectsEnvelope =
  | { ok: true; data: LinearProject[] }
  | { ok: false; error: AiErrorInfo };

/** Envelope for {@link handleComplete} / {@link handleRevoke}. */
export type LinearOAuthAckEnvelope =
  | { ok: true; data: { ok: true } }
  | { ok: false; error: AiErrorInfo };

/** The minimal HTML the loopback server returns so the user can close the tab. */
const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>SpecForge</title></head><body style="font-family:system-ui;background:#0b0d10;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>You can close this tab and return to SpecForge.</p></body></html>`;

/** The HTML returned when the callback is rejected (bad state / error param). */
const FAILURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>SpecForge</title></head><body style="font-family:system-ui;background:#0b0d10;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>Authorization failed. You can close this tab and try again in SpecForge.</p></body></html>`;

/**
 * Maps a thrown value to the shared {@link AiErrorInfo} envelope: a
 * {@link LinearRequestError} surrenders its `.info`; everything else becomes a
 * generic, non-retryable `unknown` carrying the message.
 */
function toErrorInfo(err: unknown): AiErrorInfo {
  if (err instanceof LinearRequestError) return err.info;
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'unknown', message, retryable: false };
}

function assertSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) {
    throw new Error('Invalid session id');
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

/**
 * Builds the Linear authorize URL with PKCE + state. Scopes are sent
 * **comma-delimited** (Linear's documented format). `client_id` comes from the
 * required constant so a missing registration fails loudly here.
 */
function buildAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(LINEAR_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', requireOAuthClientId());
  url.searchParams.set('redirect_uri', LINEAR_OAUTH_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  // Linear expects the scope list COMMA-delimited (not space-delimited).
  url.searchParams.set('scope', LINEAR_OAUTH_SCOPES.join(','));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', LINEAR_OAUTH_PKCE_METHOD);
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

/**
 * The OAuth IPC handler set, holding the lifecycle state (pending sessions + the
 * active loopback server) so {@link registerLinearOAuthHandlers} can both wire
 * the channels and tear the server down on quit.
 */
class LinearOAuthHandlers {
  /** sessionId → captured (but unbound) tokens. */
  private readonly sessions = new Map<string, PendingSession>();
  /** The single in-flight loopback server, or null when none is running. */
  private server: Server | null = null;
  /**
   * Rejects the in-flight {@link captureLoopbackCode} promise, or null when none
   * is pending. A second `begin` (or quit) settles the prior capture promptly
   * instead of leaving it to hang until its authorize timeout.
   */
  private abortCapture: ((reason: Error) => void) | null = null;

  constructor(private readonly oauth: OAuthRuntimeContext) {}

  /**
   * Runs the full begin flow: PKCE → open browser → loopback capture →
   * code exchange → team discovery. Returns a `sessionId` + the visible teams;
   * the tokens stay main-side in a pending session.
   */
  async begin(): Promise<LinearOAuthBeginResult> {
    const verifier = generateCodeVerifier();
    const challenge = deriveCodeChallenge(verifier);
    const state = generateState();

    // Start listening BEFORE opening the browser so the redirect can never race
    // ahead of the server being ready to accept it.
    const captured = this.captureLoopbackCode(state);

    const authorizeUrl = buildAuthorizeUrl(challenge, state);
    // If opening the browser fails, abort the in-flight capture (server + timer)
    // and drain its rejection so the listener never leaks until the authorize
    // timeout and the settled promise can't surface later as an unhandled rejection.
    try {
      await handleOpenExternal(authorizeUrl);
    } catch (err) {
      this.abortCapture?.(err instanceof Error ? err : new Error(String(err)));
      await captured.catch(() => undefined);
      throw err;
    }

    const { code } = await captured;

    const tokenResponse = await this.oauth.tokenClient.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: LINEAR_OAUTH_REDIRECT_URI,
    });

    const sessionId = this.storeSession(tokenResponse);

    try {
      const teams = await discoverTeams(this.clientForSession(sessionId));
      return { sessionId, teams };
    } catch (err) {
      // Discovery failed after the exchange already minted tokens; drop the
      // session so its in-memory credentials don't linger for an unusable flow.
      this.dropSession(sessionId);
      throw err;
    }
  }

  /** Lists the projects under a team using the pending session's access token. */
  async listProjects(sessionId: string, teamId: string): Promise<LinearProject[]> {
    this.requireSession(sessionId);
    return discoverProjects(this.clientForSession(sessionId), teamId);
  }

  /**
   * Binds a completed authorization to a connection: persists the refresh token
   * under `connectionId`, seeds the shared token-manager cache so the first push
   * doesn't immediately re-refresh, then drops the pending session.
   */
  complete(sessionId: string, connectionId: string): void {
    const session = this.requireSession(sessionId);
    const tokenResponse: OAuthTokenResponse = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresInSec: session.expiresInSec,
    };
    this.oauth.tokenManager.seedFromExchange(connectionId, tokenResponse);
    this.dropSession(sessionId);
  }

  /** Revokes the stored refresh token for a connection and clears its cache. */
  async revoke(connectionId: string): Promise<void> {
    await this.oauth.tokenManager.revoke(connectionId);
  }

  /** Tears down any in-flight loopback server + pending sessions (called on quit). */
  dispose(): void {
    this.abortCapture?.(new Error('SpecForge is shutting down; OAuth flow aborted.'));
    this.closeServer();
    for (const sessionId of [...this.sessions.keys()]) this.dropSession(sessionId);
  }

  /**
   * Stores a captured exchange as a pending session under a fresh opaque id, arming
   * its TTL eviction timer. Returns the `sessionId` the renderer will reference.
   */
  private storeSession(tokenResponse: OAuthTokenResponse): string {
    const sessionId = randomUUID();
    const evictTimer = setTimeout(() => this.dropSession(sessionId), PENDING_SESSION_TTL_MS);
    // Don't let an unbound session's eviction timer keep the app alive on quit.
    evictTimer.unref?.();
    this.sessions.set(sessionId, {
      accessToken: tokenResponse.accessToken,
      refreshToken: tokenResponse.refreshToken,
      expiresInSec: tokenResponse.expiresInSec,
      evictTimer,
    });
    return sessionId;
  }

  /** Drops a pending session (and its in-memory tokens), clearing its TTL timer. */
  private dropSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.evictTimer);
    this.sessions.delete(sessionId);
  }

  /** Looks up a pending session, throwing a clear error when it is gone/expired. */
  private requireSession(sessionId: string): PendingSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('OAuth session not found or expired; restart the connection.');
    }
    return session;
  }

  /** Builds an OAuth-backed GraphQL client from a pending session's access token. */
  private clientForSession(sessionId: string): LinearGraphQLClient {
    return new LinearGraphQLClient({
      auth: new OAuthAuth(() => this.requireSession(sessionId).accessToken),
    });
  }

  /**
   * Runs a one-shot loopback HTTP server on `127.0.0.1:<port>` to capture the
   * authorization redirect. Resolves with the `code` once a request with the
   * matching `state` arrives; rejects on a timeout, an `error` param (with a
   * matching `state`), or `EADDRINUSE`. A request with a mismatched/absent
   * `state` is treated as an unauthenticated probe — answered 400 but NOT
   * settled — so it can't cancel the in-flight flow. The server is always closed
   * before settling.
   */
  private captureLoopbackCode(expectedState: string): Promise<CapturedCode> {
    // A previous in-flight flow must be torn down first — only one at a time.
    // Reject (not just orphan) any prior capture so its caller fails promptly
    // rather than hanging until the authorize timeout fires.
    this.abortCapture?.(new Error('OAuth flow superseded by a new authorization.'));
    this.closeServer();

    return new Promise<CapturedCode>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.abortCapture = null;
        this.closeServer();
        fn();
      };
      // Expose this promise's rejector so a superseding begin (or dispose) can
      // settle it immediately.
      this.abortCapture = (reason) => finish(() => reject(reason));

      const server = createServer((req, res) => {
        // Only the callback path carries the code; ignore favicon/other probes.
        const requestUrl = new URL(req.url ?? '/', LINEAR_OAUTH_REDIRECT_URI);
        if (requestUrl.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }

        const error = requestUrl.searchParams.get('error');
        const returnedState = requestUrl.searchParams.get('state');
        const code = requestUrl.searchParams.get('code');

        // CSRF guard FIRST: the returned state MUST match the one we sent. A
        // mismatched/absent state is an unauthenticated probe (anything that can
        // reach this loopback port, e.g. `?error=access_denied`) — reject the
        // request page but DON'T settle the flow, so a stray probe can't cancel
        // the user's real authorization. The genuine callback can still arrive
        // (bounded by the authorize timeout). Only a matching state may settle.
        if (returnedState !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(FAILURE_HTML);
          return;
        }

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(FAILURE_HTML);
          finish(() => reject(new Error(`Linear authorization was denied: ${error}`)));
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(FAILURE_HTML);
          finish(() => reject(new Error('Authorization response did not include a code.')));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' }).end(SUCCESS_HTML);
        finish(() => resolve({ code }));
      });

      this.server = server;

      server.on('error', (err: NodeJS.ErrnoException) => {
        const message =
          err.code === 'EADDRINUSE'
            ? `OAuth redirect port ${LINEAR_OAUTH_REDIRECT_PORT} is already in use; close the other instance and try again.`
            : `OAuth redirect server error: ${err.message}`;
        finish(() => reject(new Error(message)));
      });

      const timer = setTimeout(() => {
        finish(() => reject(new Error('Timed out waiting for Linear authorization.')));
      }, AUTHORIZE_TIMEOUT_MS);
      // Don't let the redirect-wait timer keep the event loop (or app) alive.
      timer.unref?.();

      // 127.0.0.1 (loopback only) — never bind on all interfaces.
      server.listen(LINEAR_OAUTH_REDIRECT_PORT, '127.0.0.1');
    });
  }

  /** Closes and clears the loopback server if one is open. */
  private closeServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

/** The disposer returned by {@link registerLinearOAuthHandlers}. */
export type DisposeLinearOAuthHandlers = () => void;

/**
 * Registers the Linear OAuth IPC handlers over the shared
 * {@link OAuthRuntimeContext}. The three fallible flows return result envelopes
 * (failures travel as data); validation throws are caught and mapped to the same
 * envelope. Returns a disposer that tears down any in-flight loopback server —
 * call it from `main.ts`'s `before-quit`.
 */
export function registerLinearOAuthHandlers(
  oauth: OAuthRuntimeContext,
): DisposeLinearOAuthHandlers {
  const handlers = new LinearOAuthHandlers(oauth);

  ipcMain.handle(Channels.Begin, async (): Promise<LinearOAuthBeginEnvelope> => {
    try {
      const data = await handlers.begin();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: toErrorInfo(err) };
    }
  });

  ipcMain.handle(
    Channels.ListProjects,
    async (
      _e,
      args: { sessionId: string; teamId: string },
    ): Promise<LinearOAuthListProjectsEnvelope> => {
      try {
        assertSessionId(args?.sessionId);
        assertTeamId(args?.teamId);
        const data = await handlers.listProjects(args.sessionId, args.teamId);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: toErrorInfo(err) };
      }
    },
  );

  ipcMain.handle(
    Channels.Complete,
    async (
      _e,
      args: { sessionId: string; connectionId: string },
    ): Promise<LinearOAuthAckEnvelope> => {
      try {
        assertSessionId(args?.sessionId);
        assertConnectionId(args?.connectionId);
        handlers.complete(args.sessionId, args.connectionId);
        return { ok: true, data: { ok: true } };
      } catch (err) {
        return { ok: false, error: toErrorInfo(err) };
      }
    },
  );

  ipcMain.handle(
    Channels.Revoke,
    async (_e, args: { connectionId: string }): Promise<LinearOAuthAckEnvelope> => {
      try {
        assertConnectionId(args?.connectionId);
        await handlers.revoke(args.connectionId);
        return { ok: true, data: { ok: true } };
      } catch (err) {
        return { ok: false, error: toErrorInfo(err) };
      }
    },
  );

  return () => handlers.dispose();
}
