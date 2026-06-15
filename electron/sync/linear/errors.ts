/**
 * Linear-specific error classification & rate-limit parsing for the GraphQL
 * transport (TER-15).
 *
 * Linear's failure modes differ enough from the OpenAI-style HTTP handlers in
 * `electron/ipc/ai.ts` that reusing `httpErrorInfo` would be actively wrong, so
 * this module classifies them on Linear's own terms:
 *
 *   - **Rate limiting is HTTP 400, NOT 429.** Linear returns HTTP 400 with a
 *     GraphQL error whose `extensions.code === 'RATELIMITED'`, and ships **no**
 *     `Retry-After` header. The retry delay must instead be computed from the
 *     `X-RateLimit-Requests-Reset` header — a UTC epoch timestamp in
 *     **milliseconds** — as `reset - now`.
 *   - **GraphQL errors arrive on HTTP 200.** A perfectly successful HTTP request
 *     can still carry a top-level `errors: [{ message, path?, extensions? }]`
 *     array. The body must always be parsed; HTTP status alone is insufficient.
 *
 * The shared, Electron-free message helpers (`truncateErrorMessage`,
 * `fetchFailureInfo`) and the `AiErrorCode`/`AiErrorInfo` vocabulary are reused
 * from `electron/ipc/ai-error.ts` so the two transports speak the same error
 * language; only the Linear-specific classification lives here. This module is
 * deliberately free of any Electron/Node imports so it runs under jsdom.
 */

import {
  truncateErrorMessage,
  type AiErrorCode,
  type AiErrorInfo,
} from '../../ipc/ai-error';

/** Reuse the shared error vocabulary so Linear errors classify like AI errors. */
export type LinearErrorCode = AiErrorCode;

/** Structured, Linear-specific error info (a superset-compatible alias). */
export type LinearErrorInfo = AiErrorInfo;

/**
 * Upper bound on a computed rate-limit wait. The reset header is a server
 * clock; a skewed or malformed value could otherwise yield an absurd sleep that
 * looks like a hang. One minute comfortably covers Linear's per-window resets.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/** GraphQL `extensions.code` Linear sets on a rate-limited request. */
export const RATELIMITED_CODE = 'RATELIMITED';

/**
 * Snapshot of Linear's rate-limit headers from a single response. Every field
 * is optional because a given response may omit some (or all) of them. Resets
 * are epoch **milliseconds** (UTC), matching Linear's documented contract.
 */
export interface RateLimitSnapshot {
  /** `X-RateLimit-Requests-Limit` — max requests per window. */
  requestsLimit?: number;
  /** `X-RateLimit-Requests-Remaining` — requests left in the current window. */
  requestsRemaining?: number;
  /** `X-RateLimit-Requests-Reset` — window reset, epoch ms (UTC). */
  requestsResetMs?: number;
  /** `X-Complexity` — complexity points consumed by the request. */
  complexity?: number;
  /** `X-RateLimit-Complexity-Limit` — max complexity per window. */
  complexityLimit?: number;
  /** `X-RateLimit-Complexity-Remaining` — complexity budget left this window. */
  complexityRemaining?: number;
  /** `X-RateLimit-Complexity-Reset` — complexity window reset, epoch ms (UTC). */
  complexityResetMs?: number;
}

/** Minimal shape of a top-level GraphQL error entry (Linear-compatible). */
export interface GraphQLError {
  message: string;
  path?: Array<string | number>;
  extensions?: { code?: string; [key: string]: unknown };
}

/** Minimal shape of a GraphQL response envelope. */
export interface GraphQLResponseBody<T = unknown> {
  data?: T | null;
  errors?: GraphQLError[];
}

/** Parses one numeric header value; returns undefined when absent/non-numeric. */
function parseNumericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Parses Linear's rate-limit headers (exact casing) into a {@link RateLimitSnapshot}.
 * `Headers.get` is case-insensitive, but the names are written as Linear
 * documents them for clarity. Absent or non-numeric headers are simply omitted.
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot {
  const snapshot: RateLimitSnapshot = {};
  const set = (key: keyof RateLimitSnapshot, name: string): void => {
    const value = parseNumericHeader(headers, name);
    if (value !== undefined) snapshot[key] = value;
  };
  set('requestsLimit', 'X-RateLimit-Requests-Limit');
  set('requestsRemaining', 'X-RateLimit-Requests-Remaining');
  set('requestsResetMs', 'X-RateLimit-Requests-Reset');
  set('complexity', 'X-Complexity');
  set('complexityLimit', 'X-RateLimit-Complexity-Limit');
  set('complexityRemaining', 'X-RateLimit-Complexity-Remaining');
  set('complexityResetMs', 'X-RateLimit-Complexity-Reset');
  return snapshot;
}

/** True when a GraphQL error array carries Linear's RATELIMITED marker. */
export function isRateLimited(errors: GraphQLError[] | undefined): boolean {
  return (errors ?? []).some((e) => e.extensions?.code === RATELIMITED_CODE);
}

/**
 * Joins GraphQL `errors[].message` values into a single human-readable summary
 * (capped/whitespace-collapsed via the shared helper). Returns null when there
 * is no usable message so callers can fall back to an HTTP-status summary.
 */
export function extractGraphQLMessage(errors: GraphQLError[] | undefined): string | null {
  const messages = (errors ?? [])
    .map((e) => (typeof e.message === 'string' ? e.message.trim() : ''))
    .filter((m) => m.length > 0);
  if (messages.length === 0) return null;
  return truncateErrorMessage(messages.join('; '));
}

/**
 * Computes the wait before a rate-limited retry from the reset timestamp.
 * `reset - now`, clamped to `[0, MAX_RATE_LIMIT_WAIT_MS]` so a past/skewed reset
 * never produces a negative or runaway delay. Returns undefined when no reset
 * timestamp is available (the caller then falls back to backoff).
 */
export function rateLimitRetryAfterMs(
  snapshot: RateLimitSnapshot,
  nowMs: number,
): number | undefined {
  const reset = snapshot.requestsResetMs;
  if (reset === undefined) return undefined;
  const delta = reset - nowMs;
  if (delta <= 0) return 0;
  return Math.min(delta, MAX_RATE_LIMIT_WAIT_MS);
}

/** Inputs the classifier needs to map a Linear response to structured error info. */
export interface ClassifyInput {
  /** HTTP status of the response. */
  status: number;
  /** HTTP status text, for a fallback message. */
  statusText?: string;
  /** Parsed GraphQL errors (from HTTP 200 or 400 bodies), if any. */
  errors?: GraphQLError[];
  /** Parsed rate-limit headers for this response. */
  snapshot: RateLimitSnapshot;
  /** Current time in ms; injected so retry-after math is deterministic in tests. */
  nowMs: number;
}

/**
 * Classifies a Linear GraphQL response into structured {@link LinearErrorInfo}.
 *
 * Precedence is rate-limit first (it can ride on a 200 or a 400), then HTTP
 * status, then any remaining GraphQL errors:
 *
 *   - RATELIMITED (via `extensions.code`, or HTTP 400 marked RATELIMITED) →
 *     `rate_limit`, retryable, `retryAfterMs` derived from the reset header.
 *   - HTTP 401/403 → `auth`, not retryable.
 *   - HTTP 408 → `timeout`, retryable.
 *   - HTTP 5xx → `server`, retryable.
 *   - HTTP 400/404/422 (non-RATELIMITED) or any GraphQL errors on a 2xx →
 *     `bad_request`, not retryable (a query/validation problem retrying won't fix).
 *   - anything else → `unknown`, not retryable.
 */
export function classifyLinearResponse(input: ClassifyInput): LinearErrorInfo {
  const { status, statusText, errors, snapshot, nowMs } = input;
  const graphqlMessage = extractGraphQLMessage(errors);
  const fallback = `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
  const message = graphqlMessage ?? truncateErrorMessage(fallback);

  // Rate limiting can arrive on HTTP 400 OR (per the GraphQL extensions) even
  // alongside a 200, so it is checked before plain status mapping.
  if (isRateLimited(errors)) {
    const info: LinearErrorInfo = {
      code: 'rate_limit',
      status,
      retryable: true,
      message: graphqlMessage ?? 'Rate limited by Linear.',
    };
    const retryAfterMs = rateLimitRetryAfterMs(snapshot, nowMs);
    if (retryAfterMs !== undefined) info.retryAfterMs = retryAfterMs;
    return info;
  }

  if (status === 401 || status === 403) {
    return { code: 'auth', status, retryable: false, message };
  }
  if (status === 408) {
    return { code: 'timeout', status, retryable: true, message };
  }
  if (status >= 500) {
    return { code: 'server', status, retryable: true, message };
  }
  if (status === 400 || status === 404 || status === 422) {
    return { code: 'bad_request', status, retryable: false, message };
  }

  // HTTP was OK (or some other 2xx/3xx) but the body carried GraphQL errors:
  // a malformed query / validation failure that a retry won't fix.
  if (errors && errors.length > 0) {
    return { code: 'bad_request', status, retryable: false, message };
  }

  return { code: 'unknown', status, retryable: false, message };
}

/**
 * Carrier so a classified Linear failure survives a `throw` with its structured
 * info intact (mirrors `AiRequestError` in `electron/ipc/ai.ts`). Consumers
 * (the future `LinearAdapter`) can `instanceof`-check this and read `.info` to
 * decide how to surface the failure.
 */
export class LinearRequestError extends Error {
  constructor(readonly info: LinearErrorInfo) {
    super(info.message);
    this.name = 'LinearRequestError';
  }
}
