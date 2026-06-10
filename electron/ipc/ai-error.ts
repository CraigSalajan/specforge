/**
 * Pure error-classification helpers for the main-process AI HTTP handlers.
 * Deliberately free of any Electron / Node imports so it can be unit-tested
 * under the renderer's (browser) test runner as well as bundled into the main
 * process — same pattern as `tool-call-accumulator.ts`.
 *
 * The renderer-side mirror of `AiErrorInfo` lives in `src/app/shared/types.ts`
 * (which is kept free of cross-tree imports by convention). Keep the two
 * declarations in sync by hand.
 */

export type AiErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'server'
  | 'bad_request'
  | 'unknown';

export interface AiErrorInfo {
  code: AiErrorCode;
  /** HTTP status when the provider responded with a non-2xx. */
  status?: number;
  /** Parsed `Retry-After` hint for rate-limited requests, in milliseconds. */
  retryAfterMs?: number;
  /** True when retrying the same request can plausibly succeed. */
  retryable: boolean;
  /** Concise human-readable summary (provider message when available). */
  message: string;
}

/** Time allowed for the provider to return response headers. */
export const CONNECT_TIMEOUT_MS = 30_000;

/** Max gap between streamed chunks before the stream counts as stalled. */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/** Time allowed for a non-streaming response body to finish after headers. */
export const RESPONSE_TIMEOUT_MS = 120_000;

/** Upper bound for the human-readable summary surfaced to the UI. */
const MAX_MESSAGE_CHARS = 300;

/** Collapses whitespace and caps the summary so raw bodies can't flood the UI. */
export function truncateErrorMessage(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length > MAX_MESSAGE_CHARS
    ? `${collapsed.slice(0, MAX_MESSAGE_CHARS - 1)}…`
    : collapsed;
}

/**
 * Extracts the human-readable message from an OpenAI-compatible error body.
 * Most providers return `{ "error": { "message": "…" } }`; some return
 * `{ "error": "…" }` or a top-level `{ "message": "…" }`. Returns null when
 * the body is not JSON or carries no usable message.
 */
export function extractProviderMessage(rawBody: string): string | null {
  const trimmed = rawBody.trim();
  if (trimmed.length === 0 || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return null;
  }
  try {
    const json = JSON.parse(trimmed) as unknown;
    if (!json || typeof json !== 'object') return null;
    const obj = json as { error?: unknown; message?: unknown };
    if (typeof obj.error === 'string' && obj.error.trim().length > 0) {
      return obj.error.trim();
    }
    if (obj.error && typeof obj.error === 'object') {
      const message = (obj.error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim().length > 0) {
        return message.trim();
      }
    }
    if (typeof obj.message === 'string' && obj.message.trim().length > 0) {
      return obj.message.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/** Parses an HTTP `Retry-After` header (delta-seconds or HTTP-date) to ms. */
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/** Classifies a non-2xx provider response into a structured error. */
export function httpErrorInfo(
  status: number,
  statusText: string,
  rawBody: string,
  retryAfterHeader?: string | null,
): AiErrorInfo {
  const detail = extractProviderMessage(rawBody) ?? rawBody;
  const fallback = `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
  const message = truncateErrorMessage(detail.trim().length > 0 ? detail : fallback);

  if (status === 401 || status === 403) {
    return { code: 'auth', status, retryable: false, message };
  }
  if (status === 429) {
    const info: AiErrorInfo = { code: 'rate_limit', status, retryable: true, message };
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    if (retryAfterMs !== undefined) info.retryAfterMs = retryAfterMs;
    return info;
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
  return { code: 'unknown', status, retryable: false, message };
}

/**
 * Classifies a failure thrown by `fetch` itself (no HTTP response). Node /
 * undici surfaces connection failures as `TypeError: fetch failed` with the
 * underlying socket error attached as `cause`.
 */
export function fetchFailureInfo(err: unknown): AiErrorInfo {
  if (err instanceof TypeError) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMessage =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
    return {
      code: 'network',
      retryable: true,
      message: truncateErrorMessage(
        causeMessage.length > 0
          ? `Could not reach the provider (${causeMessage}).`
          : 'Could not reach the provider.',
      ),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'unknown',
    retryable: false,
    message: truncateErrorMessage(message.length > 0 ? message : 'Unknown error.'),
  };
}

/** A timeout enforced by the main process (watchdog-triggered abort). */
export function timeoutInfo(kind: 'connect' | 'idle' | 'response'): AiErrorInfo {
  const message =
    kind === 'connect'
      ? `The provider did not respond within ${CONNECT_TIMEOUT_MS / 1000} seconds.`
      : kind === 'idle'
        ? `The stream stalled — no data received for ${STREAM_IDLE_TIMEOUT_MS / 1000} seconds.`
        : `The provider did not finish responding within ${RESPONSE_TIMEOUT_MS / 1000} seconds.`;
  return { code: 'timeout', retryable: true, message };
}

/** A request rejected by local validation before it was ever sent. */
export function invalidRequestInfo(message: string): AiErrorInfo {
  return { code: 'bad_request', retryable: false, message: truncateErrorMessage(message) };
}

/**
 * Marker for a caller-initiated abort surfaced through a result object. The
 * renderer recognizes its own abort via the AbortSignal it tripped, so this
 * value is effectively never shown to the user.
 */
export function abortedInfo(): AiErrorInfo {
  return { code: 'unknown', retryable: false, message: 'Aborted' };
}
