import { describe, expect, it } from 'vitest';
import {
  LinearGraphQLClient,
  LINEAR_GRAPHQL_ENDPOINT,
  type LinearClientOptions,
} from '../../../electron/sync/linear/client';
import {
  OAuthAuth,
  PatAuth,
  type LinearAuth,
} from '../../../electron/sync/linear/auth';
import {
  parseRateLimitHeaders,
  rateLimitRetryAfterMs,
} from '../../../electron/sync/linear/errors';

/**
 * Unit tests for the Linear GraphQL transport (TER-15). The client is exercised
 * with fully injected fakes — a recording `fetchFn`, a `sleep` that captures
 * durations without actually waiting, a fixed `now`, and a pinned `random` — so
 * the suite is deterministic and runs under jsdom without Electron, the DB, or
 * the real network. Global `fetch` is never stubbed.
 */

const FIXED_NOW = 1_000_000;
const PAT_TOKEN = 'lin_api_secret123';
const OAUTH_TOKEN = 'oauth_access_456';

/** Builds a fake `Response` with optional rate-limit headers and a JSON body. */
function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

/**
 * A virtual clock whose `sleep` records each delay AND advances `now` by it —
 * faithfully modelling a real clock, so e.g. the proactive throttle correctly
 * becomes a no-op once a rate-limit wait has carried the clock past the reset.
 */
function virtualClock(start = FIXED_NOW): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  waits: number[];
} {
  const waits: number[] = [];
  let current = start;
  return {
    waits,
    now: () => current,
    sleep: (ms: number): Promise<void> => {
      waits.push(ms);
      current += ms;
      return Promise.resolve();
    },
  };
}

/** A queued fake `fetch`: each call yields the next scripted Response or throws. */
function queuedFetch(steps: Array<Response | Error>): {
  fn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps[i++];
    if (step === undefined) throw new Error(`queuedFetch: no scripted step for call #${i}`);
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve(step);
  }) as typeof fetch;
  return { fn, calls };
}

/** Reads the `Authorization` header off a recorded fetch call. */
function authHeaderOf(init: RequestInit): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.['Authorization'];
}

/** Base options with a virtual clock (sleep advances now) and pinned (zero) jitter. */
function baseOptions(
  auth: LinearAuth,
  fetchFn: typeof fetch,
  overrides: Partial<LinearClientOptions> = {},
): { options: LinearClientOptions; waits: number[] } {
  const clock = virtualClock();
  return {
    waits: clock.waits,
    options: {
      auth,
      fetchFn,
      sleep: clock.sleep,
      now: clock.now,
      random: () => 0,
      maxRetries: 3,
      ...overrides,
    },
  };
}

describe('LinearGraphQLClient', () => {
  describe('AC1 — PatAuth raw-token header & request shape', () => {
    it('sends the raw token (no Bearer) to the Linear endpoint and returns data', async () => {
      const data = { viewer: { id: 'u1' } };
      const { fn, calls } = queuedFetch([jsonResponse({ data })]);
      const { options } = baseOptions(new PatAuth(() => PAT_TOKEN), fn);
      const client = new LinearGraphQLClient(options);

      const result = await client.request<typeof data>('query Me { viewer { id } }', {
        a: 1,
      });

      expect(result).toEqual(data);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(LINEAR_GRAPHQL_ENDPOINT);
      expect(calls[0].init.method).toBe('POST');
      // RAW token — explicitly NOT prefixed with "Bearer ".
      expect(authHeaderOf(calls[0].init)).toBe(PAT_TOKEN);
      expect(authHeaderOf(calls[0].init)).not.toContain('Bearer');
      const sentBody = JSON.parse(String(calls[0].init.body));
      expect(sentBody).toEqual({ query: 'query Me { viewer { id } }', variables: { a: 1 } });
    });
  });

  describe('AC2 — OAuthAuth Bearer header via the same interface', () => {
    it('sends "Bearer <token>" through the shared LinearAuth interface', async () => {
      const { fn, calls } = queuedFetch([jsonResponse({ data: { ok: true } })]);
      const { options } = baseOptions(new OAuthAuth(() => OAUTH_TOKEN), fn);
      const client = new LinearGraphQLClient(options);

      await client.request('query { ok }');

      expect(authHeaderOf(calls[0].init)).toBe(`Bearer ${OAUTH_TOKEN}`);
    });

    it('rejects an empty PAT and an empty OAuth token with a clear error', async () => {
      await expect(new PatAuth(() => '').authorizationHeader()).rejects.toThrow(/Personal API key/);
      await expect(new OAuthAuth(() => '  ').authorizationHeader()).rejects.toThrow(
        /OAuth access token/,
      );
    });
  });

  describe('AC3 — retry / backoff', () => {
    it('retries an HTTP 503 then succeeds, applying backoff sleep', async () => {
      const { fn } = queuedFetch([
        jsonResponse({ errors: [{ message: 'boom' }] }, { status: 503, statusText: 'Unavailable' }),
        jsonResponse({ data: { ok: 1 } }),
      ]);
      const { options, waits } = baseOptions(new PatAuth(() => PAT_TOKEN), fn);
      const client = new LinearGraphQLClient(options);

      const data = await client.request<{ ok: number }>('query { ok }');

      expect(data).toEqual({ ok: 1 });
      // One backoff wait: base * 2^0 + jitter(0) = 500.
      expect(waits).toEqual([500]);
    });

    it('retries a thrown network error then succeeds', async () => {
      const networkErr = new TypeError('fetch failed');
      (networkErr as { cause?: unknown }).cause = new Error('ECONNRESET');
      const { fn } = queuedFetch([networkErr, jsonResponse({ data: { ok: 2 } })]);
      const { options, waits } = baseOptions(new PatAuth(() => PAT_TOKEN), fn);
      const client = new LinearGraphQLClient(options);

      const data = await client.request<{ ok: number }>('query { ok }');

      expect(data).toEqual({ ok: 2 });
      expect(waits).toHaveLength(1);
    });

    it('retries an HTTP 400 RATELIMITED, waiting the reset-derived delay, then succeeds', async () => {
      const resetMs = FIXED_NOW + 4_000;
      const { fn } = queuedFetch([
        jsonResponse(
          { errors: [{ message: 'rate limited', extensions: { code: 'RATELIMITED' } }] },
          {
            status: 400,
            statusText: 'Bad Request',
            headers: {
              'X-RateLimit-Requests-Remaining': '0',
              'X-RateLimit-Requests-Reset': String(resetMs),
            },
          },
        ),
        jsonResponse(
          { data: { ok: 3 } },
          { headers: { 'X-RateLimit-Requests-Remaining': '50' } },
        ),
      ]);
      const { options, waits } = baseOptions(new PatAuth(() => PAT_TOKEN), fn);
      const client = new LinearGraphQLClient(options);

      const data = await client.request<{ ok: number }>('query { ok }');

      expect(data).toEqual({ ok: 3 });
      // Wait derived from the reset header (reset - now), not from backoff.
      expect(waits).toEqual([4_000]);
    });

    it('does NOT retry an HTTP 401 auth error and throws a classified LinearRequestError', async () => {
      const { fn, calls } = queuedFetch([
        jsonResponse({ errors: [{ message: 'nope' }] }, { status: 401, statusText: 'Unauthorized' }),
      ]);
      const { options, waits } = baseOptions(new PatAuth(() => PAT_TOKEN), fn);
      const client = new LinearGraphQLClient(options);

      await expect(client.request('query { ok }')).rejects.toMatchObject({
        name: 'LinearRequestError',
        info: { code: 'auth', retryable: false, status: 401 },
      });
      expect(calls).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    it('does NOT retry a GraphQL validation error (bad_request) on HTTP 200', async () => {
      const { fn, calls } = queuedFetch([
        jsonResponse({
          errors: [{ message: "Field 'bogus' doesn't exist", path: ['bogus'] }],
        }),
      ]);
      const { options } = baseOptions(new PatAuth(() => PAT_TOKEN), fn);
      const client = new LinearGraphQLClient(options);

      await expect(client.request('query { bogus }')).rejects.toMatchObject({
        info: {
          code: 'bad_request',
          retryable: false,
          message: expect.stringContaining('bogus'),
        },
      });
      expect(calls).toHaveLength(1);
    });

    it('exhausts maxRetries on persistent server errors and surfaces the error', async () => {
      const fail = (): Response =>
        jsonResponse({ errors: [{ message: 'down' }] }, { status: 500, statusText: 'Server Error' });
      const { fn, calls } = queuedFetch([fail(), fail(), fail(), fail()]);
      const { options, waits } = baseOptions(new PatAuth(() => PAT_TOKEN), fn, { maxRetries: 3 });
      const client = new LinearGraphQLClient(options);

      await expect(client.request('query { ok }')).rejects.toMatchObject({
        info: { code: 'server', retryable: true },
      });
      // initial attempt + 3 retries = 4 calls; 3 backoff waits between them.
      expect(calls).toHaveLength(4);
      expect(waits).toHaveLength(3);
    });
  });

  describe('AC3 — AbortController timeout', () => {
    /**
     * These tests exercise the real `AbortController` + `setTimeout` wiring (not a
     * pre-baked error): a `fetch` whose call never resolves on its own and only
     * rejects with a real `AbortError` once the client's injected timeout aborts
     * the request signal. This proves the timeout fires, is classified as a
     * retryable `timeout`, and that the timer is cleaned up in `finally`.
     */
    it('aborts a hung request, classifies it as a retryable timeout, and retries', async () => {
      let callCount = 0;
      const fn = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        callCount++;
        if (callCount === 1) {
          // Never resolves on its own; only the injected timeout's abort settles it.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          });
        }
        return Promise.resolve(jsonResponse({ data: { ok: 9 } }));
      }) as typeof fetch;

      // Real `setTimeout`-based timeout, set tiny so the abort fires immediately.
      const { options, waits } = baseOptions(new PatAuth(() => PAT_TOKEN), fn, {
        timeoutMs: 1,
      });
      const client = new LinearGraphQLClient(options);

      const data = await client.request<{ ok: number }>('query { ok }');

      expect(data).toEqual({ ok: 9 });
      expect(callCount).toBe(2); // timed-out attempt + successful retry
      // One backoff wait between the timed-out attempt and the retry.
      expect(waits).toHaveLength(1);
    });

    it('throws a classified timeout LinearRequestError once retries are exhausted', async () => {
      const fn = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        })) as typeof fetch;

      const { options } = baseOptions(new PatAuth(() => PAT_TOKEN), fn, {
        timeoutMs: 1,
        maxRetries: 1,
      });
      const client = new LinearGraphQLClient(options);

      await expect(client.request('query { ok }')).rejects.toMatchObject({
        name: 'LinearRequestError',
        info: { code: 'timeout', retryable: true },
      });
    });
  });

  describe('AC4 — rate-limit header parsing & proactive throttle', () => {
    it('parses requests-remaining/-reset into lastRateLimit', async () => {
      const resetMs = FIXED_NOW + 9_000;
      const { fn } = queuedFetch([
        jsonResponse(
          { data: { ok: 1 } },
          {
            headers: {
              'X-RateLimit-Requests-Limit': '1500',
              'X-RateLimit-Requests-Remaining': '7',
              'X-RateLimit-Requests-Reset': String(resetMs),
            },
          },
        ),
      ]);
      const { options } = baseOptions(new PatAuth(() => PAT_TOKEN), fn);
      const client = new LinearGraphQLClient(options);

      await client.request('query { ok }');

      expect(client.lastRateLimit).toMatchObject({
        requestsLimit: 1500,
        requestsRemaining: 7,
        requestsResetMs: resetMs,
      });
    });

    it('proactively sleeps until reset when the prior response left remaining: 0', async () => {
      const resetMs = FIXED_NOW + 6_000;
      const { fn, calls } = queuedFetch([
        jsonResponse(
          { data: { first: true } },
          {
            headers: {
              'X-RateLimit-Requests-Remaining': '0',
              'X-RateLimit-Requests-Reset': String(resetMs),
            },
          },
        ),
        jsonResponse(
          { data: { second: true } },
          { headers: { 'X-RateLimit-Requests-Remaining': '99' } },
        ),
      ]);
      const { options, waits } = baseOptions(new PatAuth(() => PAT_TOKEN), fn);
      const client = new LinearGraphQLClient(options);

      await client.request('query { first }');
      // No proactive wait before the first request (no prior snapshot).
      expect(waits).toEqual([]);

      await client.request('query { second }');
      // Second request sleeps until the reset (reset - now) before sending.
      expect(waits).toEqual([6_000]);
      expect(calls).toHaveLength(2);
    });
  });

  describe('GraphQL-200-with-errors parsing', () => {
    it('throws a classified error when a 200 body carries errors[]', async () => {
      const { fn } = queuedFetch([
        jsonResponse({ errors: [{ message: 'Something broke', extensions: { code: 'INTERNAL' } }] }),
      ]);
      const { options } = baseOptions(new PatAuth(() => PAT_TOKEN), fn);
      const client = new LinearGraphQLClient(options);

      await expect(client.request('query { x }')).rejects.toMatchObject({
        name: 'LinearRequestError',
        info: { code: 'bad_request', message: 'Something broke' },
      });
    });

    it('throws (does not return null) on a 2xx with neither data nor errors', async () => {
      const { fn, calls } = queuedFetch([jsonResponse({})]);
      const { options, waits } = baseOptions(new PatAuth(() => PAT_TOKEN), fn);
      const client = new LinearGraphQLClient(options);

      await expect(client.request('query { x }')).rejects.toMatchObject({
        name: 'LinearRequestError',
        info: { code: 'unknown', retryable: false },
      });
      // A contract violation, not a transient fault — it must fail fast.
      expect(calls).toHaveLength(1);
      expect(waits).toEqual([]);
    });
  });
});

describe('rate-limit header helpers', () => {
  it('parseRateLimitHeaders reads the documented header set', () => {
    const headers = new Headers({
      'X-RateLimit-Requests-Limit': '1500',
      'X-RateLimit-Requests-Remaining': '0',
      'X-RateLimit-Requests-Reset': '1234567890000',
      'X-Complexity': '42',
      'X-RateLimit-Complexity-Limit': '250000',
      'X-RateLimit-Complexity-Remaining': '249958',
      'X-RateLimit-Complexity-Reset': '1234567899000',
    });
    expect(parseRateLimitHeaders(headers)).toEqual({
      requestsLimit: 1500,
      requestsRemaining: 0,
      requestsResetMs: 1234567890000,
      complexity: 42,
      complexityLimit: 250000,
      complexityRemaining: 249958,
      complexityResetMs: 1234567899000,
    });
  });

  it('omits headers that are absent or non-numeric', () => {
    const headers = new Headers({ 'X-RateLimit-Requests-Remaining': 'not-a-number' });
    expect(parseRateLimitHeaders(headers)).toEqual({});
  });

  it('rateLimitRetryAfterMs clamps to [0, cap] and undefined without a reset', () => {
    expect(rateLimitRetryAfterMs({ requestsResetMs: 5_000 }, 1_000)).toBe(4_000);
    expect(rateLimitRetryAfterMs({ requestsResetMs: 500 }, 1_000)).toBe(0);
    expect(rateLimitRetryAfterMs({ requestsResetMs: 10_000_000 }, 0)).toBe(60_000);
    expect(rateLimitRetryAfterMs({}, 1_000)).toBeUndefined();
  });
});
