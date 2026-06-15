/**
 * Linear GraphQL transport client (TER-15).
 *
 * The single low-level HTTP layer through which the future `LinearAdapter`
 * (TER-14) talks to Linear: it owns the endpoint, the `Authorization` header,
 * per-request timeouts, retry/backoff, and rate-limit handling, and exposes a
 * single generic `request<T>(query, variables)`. It builds NOTHING above that —
 * no adapter, no registry, no IPC — that is out of scope.
 *
 * ## Why everything is injected
 * Following the house style of `electron/ipc/ai.ts`, every side-effect enters
 * through {@link LinearClientOptions}: the network (`fetchFn`), the clock
 * (`now`), waiting (`sleep`), and jitter (`random`). At module scope the client
 * touches no Electron, no DB, and no global timers, so it bundles into the main
 * process yet runs unmodified under the renderer's jsdom test runner with
 * deterministic fakes (a recording `sleep`, a fixed `now`, a pinned `random`).
 * The credential never enters directly either — it arrives via the injected
 * {@link LinearAuth}, which alone knows the PAT-vs-OAuth header shape.
 *
 * ## Linear's two non-obvious failure rules (see ./errors)
 *   1. Rate limiting is **HTTP 400 + `extensions.code === 'RATELIMITED'`** (not
 *      429), with **no** `Retry-After` header — the wait is derived from the
 *      `X-RateLimit-Requests-Reset` header (epoch ms).
 *   2. GraphQL errors can arrive on **HTTP 200**, so every response body is
 *      parsed; HTTP status alone is never trusted.
 *
 * ## Retry & proactive throttle
 * Retryable failures (`server`, `timeout`, `network`, `rate_limit`) are retried
 * up to `maxRetries`. A `rate_limit` waits the reset-derived delay; everything
 * else uses capped exponential backoff with injected jitter. Independently, the
 * client *proactively* throttles: it remembers the latest
 * {@link RateLimitSnapshot}, and before issuing a request — if the last response
 * said `requestsRemaining <= 0` with a future reset — it sleeps until the reset
 * rather than spending a request just to be told 400/RATELIMITED.
 *
 * @see ./auth for the {@link LinearAuth} header abstraction.
 * @see ./errors for rate-limit parsing and Linear-specific classification.
 */

import { fetchFailureInfo } from '../../ipc/ai-error';
import type { LinearAuth } from './auth';
import {
  LinearRequestError,
  classifyLinearResponse,
  parseRateLimitHeaders,
  type GraphQLResponseBody,
  type LinearErrorInfo,
  type RateLimitSnapshot,
} from './errors';

/** Linear's single GraphQL endpoint. */
export const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

/** Default per-request timeout (headers + body). Mirrors the AI connect bound. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default number of retries after the initial attempt. */
export const DEFAULT_MAX_RETRIES = 3;

/** Base delay for exponential backoff (non rate-limit retries). */
export const DEFAULT_BACKOFF_BASE_MS = 500;

/** Upper bound on a single backoff wait so the cap stays sane under many retries. */
export const MAX_BACKOFF_MS = 10_000;

/** Error codes worth retrying; everything else fails fast. */
const RETRYABLE_CODES: ReadonlySet<LinearErrorInfo['code']> = new Set([
  'server',
  'timeout',
  'network',
  'rate_limit',
]);

/**
 * Construction options. All side-effects are injectable with production-sane
 * defaults so the client is fully deterministic under test.
 */
export interface LinearClientOptions {
  /** Credential abstraction supplying the full `Authorization` header value. */
  auth: LinearAuth;
  /** GraphQL endpoint; defaults to {@link LINEAR_GRAPHQL_ENDPOINT}. */
  endpoint?: string;
  /** `fetch` implementation; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Awaitable delay; defaults to a real `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Current epoch ms; defaults to `Date.now`. */
  now?: () => number;
  /** Jitter source in `[0, 1)`; defaults to `Math.random`. */
  random?: () => number;
  /** Retries after the first attempt; defaults to {@link DEFAULT_MAX_RETRIES}. */
  maxRetries?: number;
  /** Per-request timeout in ms; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Real `setTimeout`-based sleep; replaced by a recording fake in tests. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when `err` is an abort signalled by the timeout `AbortController`.
 *
 * Detection is by `name === 'AbortError'` rather than `instanceof Error`: Node's
 * `fetch` aborts with a `DOMException`, which is an `Error` subclass under Node
 * but NOT under every DOM implementation (e.g. the renderer's jsdom test
 * runner). Keying on the name keeps abort classification correct in every
 * runtime this module is bundled for.
 */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

export class LinearGraphQLClient {
  private readonly auth: LinearAuth;
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  /** Latest parsed rate-limit snapshot, exposed for observability/tests. */
  private snapshot: RateLimitSnapshot = {};

  constructor(options: LinearClientOptions) {
    this.auth = options.auth;
    this.endpoint = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The most recent rate-limit snapshot parsed from a Linear response. */
  get lastRateLimit(): RateLimitSnapshot {
    return this.snapshot;
  }

  /**
   * Execute a GraphQL operation and return its `data` typed as `T`.
   *
   * Posts `{ query, variables }` as JSON with the auth header, applies a
   * proactive rate-limit throttle, retries retryable failures with backoff
   * (or the reset-derived wait for rate limits), and throws a
   * {@link LinearRequestError} carrying structured info on a non-retryable
   * failure or once retries are exhausted.
   *
   * @param query the GraphQL query/mutation document.
   * @param variables optional operation variables.
   * @returns the response `data` cast to `T`.
   * @throws {LinearRequestError} on classified failure.
   */
  async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let lastError: LinearErrorInfo | undefined;

    // attempt 0 is the initial try; 1..maxRetries are retries.
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Proactive throttle: if the previous response exhausted the window and
      // the reset is still in the future, wait it out rather than burning a
      // request on a guaranteed 400/RATELIMITED.
      await this.throttleIfExhausted();

      let result: { ok: true; data: T } | { ok: false; info: LinearErrorInfo };
      try {
        result = await this.attempt<T>(query, variables);
      } catch (err) {
        // A thrown fetch failure (network) — never an HTTP response. Abort
        // (timeout) maps to a retryable timeout; everything else via the shared
        // network classifier.
        result = { ok: false, info: this.classifyThrown(err) };
      }

      if (result.ok) return result.data;

      lastError = result.info;
      if (!RETRYABLE_CODES.has(result.info.code) || attempt === this.maxRetries) {
        break;
      }

      const delayMs = this.retryDelayMs(result.info, attempt);
      console.warn(
        `[linear] request failed (${result.info.code}); retry ${attempt + 1}/${this.maxRetries} in ${delayMs}ms: ${result.info.message}`,
      );
      await this.sleep(delayMs);
    }

    throw new LinearRequestError(
      lastError ?? { code: 'unknown', retryable: false, message: 'Unknown Linear request failure.' },
    );
  }

  /**
   * A single network attempt: POST, parse rate-limit headers (always), parse the
   * body, then classify. Returns the typed `data` on success or structured info
   * on a failure that came back as an HTTP response. Throws only when `fetch`
   * itself throws (network/abort), which {@link request} classifies.
   */
  private async attempt<T>(
    query: string,
    variables: Record<string, unknown> | undefined,
  ): Promise<{ ok: true; data: T } | { ok: false; info: LinearErrorInfo }> {
    const authorization = await this.auth.authorizationHeader();
    const controller = new AbortController();
    const timer =
      this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : null;

    let res: Response;
    try {
      res = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    // Always refresh the snapshot from response headers so the proactive
    // throttle and `lastRateLimit` reflect the most recent window state.
    this.snapshot = parseRateLimitHeaders(res.headers);

    const body = await this.readBody(res);
    const errors = body?.errors;

    // Success: HTTP 2xx with no GraphQL errors.
    if (res.ok && (!errors || errors.length === 0)) {
      return { ok: true, data: (body?.data ?? null) as T };
    }

    return {
      ok: false,
      info: classifyLinearResponse({
        status: res.status,
        statusText: res.statusText,
        errors,
        snapshot: this.snapshot,
        nowMs: this.now(),
      }),
    };
  }

  /** Parses a JSON GraphQL envelope; tolerates an unreadable/non-JSON body. */
  private async readBody(res: Response): Promise<GraphQLResponseBody | null> {
    try {
      return (await res.json()) as GraphQLResponseBody;
    } catch {
      return null;
    }
  }

  /** Maps a thrown fetch failure to structured info (abort → timeout, else network). */
  private classifyThrown(err: unknown): LinearErrorInfo {
    if (isAbortError(err)) {
      return {
        code: 'timeout',
        retryable: true,
        message: `Linear did not respond within ${this.timeoutMs / 1000} seconds.`,
      };
    }
    // Reuse the shared undici "fetch failed" classifier (retryable network).
    return fetchFailureInfo(err);
  }

  /** Chooses the wait before a retry: reset-derived for rate limits, else backoff. */
  private retryDelayMs(info: LinearErrorInfo, attempt: number): number {
    if (info.code === 'rate_limit' && info.retryAfterMs !== undefined) {
      return info.retryAfterMs;
    }
    return this.backoffMs(attempt);
  }

  /** Capped exponential backoff with injected jitter: base * 2^attempt + jitter. */
  private backoffMs(attempt: number): number {
    const exponential = DEFAULT_BACKOFF_BASE_MS * 2 ** attempt;
    const capped = Math.min(exponential, MAX_BACKOFF_MS);
    // Full jitter in [0, base): spreads retries so concurrent clients don't
    // synchronize. `random()` is injected, so this is deterministic in tests.
    const jitter = Math.floor(this.random() * DEFAULT_BACKOFF_BASE_MS);
    return capped + jitter;
  }

  /**
   * Proactive throttle: when the last response left no request budget and the
   * reset is still ahead, sleep until then. A no-op when budget remains or the
   * reset has already passed.
   */
  private async throttleIfExhausted(): Promise<void> {
    const { requestsRemaining, requestsResetMs } = this.snapshot;
    if (requestsRemaining === undefined || requestsRemaining > 0) return;
    if (requestsResetMs === undefined) return;
    const waitMs = requestsResetMs - this.now();
    if (waitMs <= 0) return;
    console.warn(`[linear] request budget exhausted; waiting ${waitMs}ms for reset.`);
    await this.sleep(waitMs);
  }
}
