import { describe, expect, it } from 'vitest';
import {
  LinearTokenClient,
  OAuthReconnectRequiredError,
} from '../../../electron/sync/linear/oauth/token-client';
import {
  LINEAR_OAUTH_REVOKE_URL,
  LINEAR_OAUTH_TOKEN_URL,
} from '../../../electron/sync/linear/auth';

/**
 * Unit tests for the Linear OAuth token client (TER-33). Fully injected: a
 * recording fake `fetch` and a stubbed `resolveClientId` (so the empty build-time
 * constant doesn't gate the tests, and the node-free `auth` module is never
 * mocked). Asserts the exact form bodies, comma-delimited scope handling, the
 * parsed response shape, and the `invalid_grant` → reconnect mapping.
 */

const STUB_CLIENT_ID = 'stub-client-id';
const REDIRECT_URI = 'http://127.0.0.1:53217/callback';

/** A fake `Response` for a form-encoded JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A recording fake `fetch`: yields the next scripted response, capturing calls. */
function recordingFetch(steps: Response[]): {
  fn: typeof fetch;
  calls: Array<{ url: string; method?: string; headers?: HeadersInit; body: string }>;
} {
  const calls: Array<{ url: string; method?: string; headers?: HeadersInit; body: string }> = [];
  let i = 0;
  const fn = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers,
      body: String(init?.body ?? ''),
    });
    const step = steps[i++];
    if (!step) throw new Error(`recordingFetch: no scripted step for call #${i}`);
    return Promise.resolve(step);
  }) as typeof fetch;
  return { fn, calls };
}

/** Parses the form-encoded body of a recorded call into URLSearchParams. */
function formOf(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

function makeClient(steps: Response[]): {
  client: LinearTokenClient;
  calls: ReturnType<typeof recordingFetch>['calls'];
} {
  const { fn, calls } = recordingFetch(steps);
  const client = new LinearTokenClient({ fetchFn: fn, resolveClientId: () => STUB_CLIENT_ID });
  return { client, calls };
}

const SUCCESS_BODY = {
  access_token: 'access-abc',
  token_type: 'Bearer',
  expires_in: 86399,
  refresh_token: 'refresh-xyz',
  scope: 'read,write,issues:create',
};

describe('LinearTokenClient.exchangeCode', () => {
  it('POSTs the correct auth-code form body (no client_secret) and parses the response', async () => {
    const { client, calls } = makeClient([jsonResponse(SUCCESS_BODY)]);

    const result = await client.exchangeCode({
      code: 'the-code',
      codeVerifier: 'the-verifier',
      redirectUri: REDIRECT_URI,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(LINEAR_OAUTH_TOKEN_URL);
    expect(calls[0].method).toBe('POST');
    expect((calls[0].headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );

    const form = formOf(calls[0].body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('client_id')).toBe(STUB_CLIENT_ID);
    expect(form.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(form.get('code_verifier')).toBe('the-verifier');
    // PUBLIC client — a secret must NEVER be sent.
    expect(form.has('client_secret')).toBe(false);

    expect(result).toEqual({
      accessToken: 'access-abc',
      refreshToken: 'refresh-xyz',
      expiresInSec: 86399,
      scope: 'read,write,issues:create',
    });
  });

  it('maps an invalid_grant error to OAuthReconnectRequiredError', async () => {
    const { client } = makeClient([
      jsonResponse({ error: 'invalid_grant', error_description: 'code expired' }, 400),
    ]);

    await expect(
      client.exchangeCode({ code: 'x', codeVerifier: 'y', redirectUri: REDIRECT_URI }),
    ).rejects.toBeInstanceOf(OAuthReconnectRequiredError);
  });
});

describe('LinearTokenClient.refresh', () => {
  it('POSTs the refresh-grant form body (client_id, no secret) and parses the rotated tokens', async () => {
    const rotated = { ...SUCCESS_BODY, access_token: 'access-2', refresh_token: 'refresh-2' };
    const { client, calls } = makeClient([jsonResponse(rotated)]);

    const result = await client.refresh('old-refresh');

    const form = formOf(calls[0].body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('old-refresh');
    expect(form.get('client_id')).toBe(STUB_CLIENT_ID);
    expect(form.has('client_secret')).toBe(false);

    // The response carries a NEW (rotated) refresh token.
    expect(result.refreshToken).toBe('refresh-2');
    expect(result.accessToken).toBe('access-2');
    expect(result.expiresInSec).toBe(86399);
  });

  it('parses a comma-delimited scope string verbatim', async () => {
    const { client } = makeClient([
      jsonResponse({ ...SUCCESS_BODY, scope: 'read,write,issues:create,comments:create' }),
    ]);
    const result = await client.refresh('r');
    expect(result.scope).toBe('read,write,issues:create,comments:create');
  });

  it('maps invalid_grant to OAuthReconnectRequiredError (dead refresh token)', async () => {
    const { client } = makeClient([
      jsonResponse({ error: 'invalid_grant', error_description: 'token revoked' }, 400),
    ]);
    await expect(client.refresh('dead')).rejects.toBeInstanceOf(OAuthReconnectRequiredError);
  });

  it('throws a generic error (not reconnect) for a non-invalid_grant failure', async () => {
    const { client } = makeClient([
      jsonResponse({ error: 'server_error', error_description: 'boom' }, 500),
    ]);
    const err = await client.refresh('r').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OAuthReconnectRequiredError);
  });

  it('rejects a 2xx body missing the access_token', async () => {
    const { client } = makeClient([jsonResponse({ refresh_token: 'only-refresh' })]);
    await expect(client.refresh('r')).rejects.toThrow(/access_token/);
  });
});

describe('LinearTokenClient.revoke', () => {
  it('POSTs token + token_type_hint to the revoke endpoint and resolves on 200', async () => {
    const { client, calls } = makeClient([new Response('', { status: 200 })]);

    await client.revoke('refresh-xyz', 'refresh_token');

    expect(calls[0].url).toBe(LINEAR_OAUTH_REVOKE_URL);
    const form = formOf(calls[0].body);
    expect(form.get('token')).toBe('refresh-xyz');
    expect(form.get('token_type_hint')).toBe('refresh_token');
  });

  it('throws on a non-2xx revoke response', async () => {
    const { client } = makeClient([new Response('', { status: 400 })]);
    await expect(client.revoke('x')).rejects.toThrow(/revocation failed/);
  });
});
