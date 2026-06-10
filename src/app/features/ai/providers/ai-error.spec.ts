import {
  CONNECT_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  extractProviderMessage,
  fetchFailureInfo,
  httpErrorInfo,
  invalidRequestInfo,
  parseRetryAfterMs,
  timeoutInfo,
  truncateErrorMessage,
} from '../../../../../electron/ipc/ai-error';

/**
 * Tests the pure error-classification module used by the main-process AI
 * handlers (same Electron-free pattern as `tool-call-accumulator.ts`): HTTP
 * status → code mapping, provider-JSON message extraction, Retry-After
 * parsing, fetch-failure classification, and watchdog timeout shapes.
 */
describe('ai-error classification', () => {
  describe('httpErrorInfo status mapping', () => {
    it('maps 401/403 to a non-retryable auth error', () => {
      for (const status of [401, 403]) {
        const info = httpErrorInfo(status, 'Unauthorized', '');
        expect(info.code).toBe('auth');
        expect(info.status).toBe(status);
        expect(info.retryable).toBe(false);
      }
    });

    it('maps 429 to a retryable rate_limit with a parsed Retry-After hint', () => {
      const info = httpErrorInfo(429, 'Too Many Requests', '', '7');
      expect(info.code).toBe('rate_limit');
      expect(info.retryable).toBe(true);
      expect(info.retryAfterMs).toBe(7000);
    });

    it('omits retryAfterMs when no Retry-After header is present', () => {
      const info = httpErrorInfo(429, 'Too Many Requests', '');
      expect(info.code).toBe('rate_limit');
      expect(info.retryAfterMs).toBeUndefined();
    });

    it('maps 5xx to a retryable server error', () => {
      for (const status of [500, 502, 503]) {
        const info = httpErrorInfo(status, 'Server Error', '');
        expect(info.code).toBe('server');
        expect(info.retryable).toBe(true);
      }
    });

    it('maps 400/404/422 to a non-retryable bad_request', () => {
      for (const status of [400, 404, 422]) {
        const info = httpErrorInfo(status, 'Bad Request', '');
        expect(info.code).toBe('bad_request');
        expect(info.retryable).toBe(false);
      }
    });

    it('maps 408 to a retryable timeout', () => {
      const info = httpErrorInfo(408, 'Request Timeout', '');
      expect(info.code).toBe('timeout');
      expect(info.retryable).toBe(true);
    });

    it('maps anything else to a non-retryable unknown', () => {
      const info = httpErrorInfo(418, "I'm a teapot", '');
      expect(info.code).toBe('unknown');
      expect(info.retryable).toBe(false);
    });

    it('uses the parsed provider message, never the raw JSON body', () => {
      const body = JSON.stringify({
        error: { message: 'Incorrect API key provided', type: 'invalid_request_error' },
      });
      const info = httpErrorInfo(401, 'Unauthorized', body);
      expect(info.message).toBe('Incorrect API key provided');
      expect(info.message).not.toContain('{');
    });

    it('falls back to "HTTP <status> <statusText>" for an empty body', () => {
      const info = httpErrorInfo(503, 'Service Unavailable', '');
      expect(info.message).toBe('HTTP 503 Service Unavailable');
    });

    it('caps a non-JSON body dump so it cannot flood the UI', () => {
      const info = httpErrorInfo(500, 'Server Error', 'x'.repeat(5000));
      expect(info.message.length).toBeLessThanOrEqual(300);
      expect(info.message.endsWith('…')).toBe(true);
    });
  });

  describe('extractProviderMessage', () => {
    it('reads the OpenAI shape { error: { message } }', () => {
      expect(extractProviderMessage('{"error":{"message":"boom"}}')).toBe('boom');
    });

    it('reads a string error shape { error: "…" }', () => {
      expect(extractProviderMessage('{"error":"quota exceeded"}')).toBe('quota exceeded');
    });

    it('reads a top-level { message } shape', () => {
      expect(extractProviderMessage('{"message":"model not found"}')).toBe('model not found');
    });

    it('returns null for non-JSON, empty, or messageless bodies', () => {
      expect(extractProviderMessage('<html>502 Bad Gateway</html>')).toBeNull();
      expect(extractProviderMessage('')).toBeNull();
      expect(extractProviderMessage('{"detail":42}')).toBeNull();
      expect(extractProviderMessage('{not json')).toBeNull();
    });
  });

  describe('parseRetryAfterMs', () => {
    it('parses delta-seconds', () => {
      expect(parseRetryAfterMs('30')).toBe(30_000);
      expect(parseRetryAfterMs('0')).toBe(0);
    });

    it('parses an HTTP-date relative to now', () => {
      const future = new Date(Date.now() + 10_000).toUTCString();
      const ms = parseRetryAfterMs(future);
      expect(ms).toBeGreaterThan(5_000);
      expect(ms).toBeLessThanOrEqual(10_000);
    });

    it('clamps past dates to zero', () => {
      const past = new Date(Date.now() - 60_000).toUTCString();
      expect(parseRetryAfterMs(past)).toBe(0);
    });

    it('returns undefined for missing or unparsable values', () => {
      expect(parseRetryAfterMs(null)).toBeUndefined();
      expect(parseRetryAfterMs(undefined)).toBeUndefined();
      expect(parseRetryAfterMs('soon')).toBeUndefined();
    });
  });

  describe('truncateErrorMessage', () => {
    it('collapses whitespace', () => {
      expect(truncateErrorMessage('  a\n\n  b\tc  ')).toBe('a b c');
    });

    it('caps long text with an ellipsis', () => {
      const out = truncateErrorMessage('y'.repeat(1000));
      expect(out.length).toBe(300);
      expect(out.endsWith('…')).toBe(true);
    });
  });

  describe('fetchFailureInfo', () => {
    it('classifies undici "fetch failed" TypeErrors as retryable network errors', () => {
      const err = new TypeError('fetch failed');
      (err as { cause?: unknown }).cause = new Error('connect ECONNREFUSED 127.0.0.1:443');
      const info = fetchFailureInfo(err);
      expect(info.code).toBe('network');
      expect(info.retryable).toBe(true);
      expect(info.message).toContain('ECONNREFUSED');
    });

    it('still maps a cause-less TypeError to network', () => {
      const info = fetchFailureInfo(new TypeError('fetch failed'));
      expect(info.code).toBe('network');
      expect(info.retryable).toBe(true);
    });

    it('maps anything else to a non-retryable unknown carrying the message', () => {
      const info = fetchFailureInfo(new Error('something odd'));
      expect(info.code).toBe('unknown');
      expect(info.retryable).toBe(false);
      expect(info.message).toBe('something odd');
    });
  });

  describe('timeoutInfo', () => {
    it('produces retryable timeout errors mentioning the watchdog bound', () => {
      const connect = timeoutInfo('connect');
      expect(connect.code).toBe('timeout');
      expect(connect.retryable).toBe(true);
      expect(connect.message).toContain(String(CONNECT_TIMEOUT_MS / 1000));

      const idle = timeoutInfo('idle');
      expect(idle.code).toBe('timeout');
      expect(idle.message).toContain(String(STREAM_IDLE_TIMEOUT_MS / 1000));
    });
  });

  describe('invalidRequestInfo', () => {
    it('produces a non-retryable bad_request', () => {
      const info = invalidRequestInfo('baseUrl must be a non-empty string');
      expect(info.code).toBe('bad_request');
      expect(info.retryable).toBe(false);
      expect(info.message).toBe('baseUrl must be a non-empty string');
    });
  });
});
