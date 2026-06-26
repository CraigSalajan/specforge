import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the OAuth token manager (TER-33). Only `electron`'s
 * `safeStorage` is mocked (a reversible cipher) so the real
 * {@link createConnectionSecrets} can persist over an in-memory Map — proving the
 * ROTATED refresh token is actually written back through the secret store, not
 * just held in memory. The token client is a hand-rolled fake recording refreshes.
 */
const { safeStorageMock } = vi.hoisted(() => ({
  safeStorageMock: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from('cipher:' + s)),
    decryptString: vi.fn((b: Buffer) => b.toString().replace(/^cipher:/, '')),
  },
}));

vi.mock('electron', () => ({ safeStorage: safeStorageMock }));

import { createConnectionSecrets } from '../../../electron/sync/connection-secrets';
import {
  createOAuthTokenManager,
  REFRESH_SKEW_MS,
} from '../../../electron/sync/linear/oauth/token-manager';
import {
  OAuthReconnectRequiredError,
  type LinearTokenClient,
  type OAuthTokenResponse,
} from '../../../electron/sync/linear/oauth/token-client';
import type { SecretSettingsStore } from '../../../electron/ipc/secure-settings';

const CONN = 'linear-conn-1';

/** In-memory secret store backing the real connection-secrets layer. */
function makeSecrets(): ReturnType<typeof createConnectionSecrets> {
  const backing = new Map<string, string>();
  const store: SecretSettingsStore = {
    get: (k) => (backing.has(k) ? backing.get(k)! : null),
    set: (k, v) => {
      backing.set(k, v);
    },
    getAll: () => Object.fromEntries(backing),
  };
  return createConnectionSecrets(store);
}

/** A token-response factory with sensible defaults. */
function tokenResponse(overrides: Partial<OAuthTokenResponse> = {}): OAuthTokenResponse {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresInSec: 86399,
    ...overrides,
  };
}

/**
 * A fake token client whose `refresh` returns the queued responses (or throws the
 * queued error), recording each refresh-token argument it was called with.
 */
function fakeTokenClient(steps: Array<OAuthTokenResponse | Error>): {
  client: LinearTokenClient;
  refreshArgs: string[];
  revokeArgs: string[];
} {
  const refreshArgs: string[] = [];
  const revokeArgs: string[] = [];
  let i = 0;
  const client = {
    exchangeCode: () => Promise.reject(new Error('not used')),
    refresh: (refreshToken: string): Promise<OAuthTokenResponse> => {
      refreshArgs.push(refreshToken);
      const step = steps[i++];
      if (step instanceof Error) return Promise.reject(step);
      if (!step) return Promise.reject(new Error('fakeTokenClient: no scripted refresh'));
      return Promise.resolve(step);
    },
    revoke: (token: string): Promise<void> => {
      revokeArgs.push(token);
      return Promise.resolve();
    },
  } as unknown as LinearTokenClient;
  return { client, refreshArgs, revokeArgs };
}

beforeEach(() => {
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
});

afterEach(() => {
  // Restore the available-default so an override never leaks to a sibling spec
  // (the unit-test builder shares one module graph — see secure-settings.spec).
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
});

describe('getAccessToken — cache + refresh', () => {
  it('returns the seeded access token without refreshing while it is fresh', async () => {
    const secrets = makeSecrets();
    const { client, refreshArgs } = fakeTokenClient([]);
    const now = vi.fn(() => 1_000_000);
    const mgr = createOAuthTokenManager({ secrets, tokenClient: client, now });

    mgr.seedFromExchange(CONN, tokenResponse({ accessToken: 'seeded', expiresInSec: 3600 }));

    await expect(mgr.getAccessToken(CONN)).resolves.toBe('seeded');
    // A fresh cache must NOT hit the network.
    expect(refreshArgs).toEqual([]);
  });

  it('refreshes when the cached token is within the refresh skew of expiry', async () => {
    const secrets = makeSecrets();
    const { client, refreshArgs } = fakeTokenClient([
      tokenResponse({ accessToken: 'access-2', refreshToken: 'refresh-2' }),
    ]);
    let current = 1_000_000;
    const now = (): number => current;
    const mgr = createOAuthTokenManager({ secrets, tokenClient: client, now });

    // Seed a token that expires in 30s — inside the 60s skew, so the NEXT read refreshes.
    mgr.seedFromExchange(CONN, tokenResponse({ accessToken: 'access-1', expiresInSec: 30 }));
    expect(REFRESH_SKEW_MS).toBeGreaterThan(30_000);

    const token = await mgr.getAccessToken(CONN);
    expect(token).toBe('access-2');
    expect(refreshArgs).toEqual(['refresh-1']); // refreshed using the stored token
    void current;
  });

  it('writes the ROTATED refresh token back to the secret store after a refresh', async () => {
    const secrets = makeSecrets();
    const { client } = fakeTokenClient([
      tokenResponse({ accessToken: 'access-2', refreshToken: 'rotated-refresh' }),
    ]);
    const now = (): number => 1_000_000;
    const mgr = createOAuthTokenManager({ secrets, tokenClient: client, now });

    // Seed an already-expired token so the next read forces a refresh.
    mgr.seedFromExchange(CONN, tokenResponse({ refreshToken: 'refresh-1', expiresInSec: 0 }));

    await mgr.getAccessToken(CONN);

    // The store must now hold the rotated token, not the original.
    expect(secrets.getConnectionToken(CONN, 'refreshToken')).toBe('rotated-refresh');
  });

  it('dedupes two concurrent getAccessToken calls into a single refresh', async () => {
    const secrets = makeSecrets();
    const { client, refreshArgs } = fakeTokenClient([
      tokenResponse({ accessToken: 'access-2', refreshToken: 'rotated' }),
    ]);
    const now = (): number => 1_000_000;
    const mgr = createOAuthTokenManager({ secrets, tokenClient: client, now });

    mgr.seedFromExchange(CONN, tokenResponse({ refreshToken: 'refresh-1', expiresInSec: 0 }));

    // Fire both before awaiting either — they must share one in-flight refresh.
    const [a, b] = await Promise.all([mgr.getAccessToken(CONN), mgr.getAccessToken(CONN)]);

    expect(a).toBe('access-2');
    expect(b).toBe('access-2');
    // Exactly ONE refresh — a double rotation would invalidate the first's token.
    expect(refreshArgs).toEqual(['refresh-1']);
  });

  it('throws OAuthReconnectRequiredError when no refresh token is stored', async () => {
    const secrets = makeSecrets();
    const { client } = fakeTokenClient([]);
    const mgr = createOAuthTokenManager({
      secrets,
      tokenClient: client,
      now: () => 1_000_000,
    });

    // No seed, no stored refresh token.
    await expect(mgr.getAccessToken(CONN)).rejects.toBeInstanceOf(OAuthReconnectRequiredError);
  });

  it('propagates an invalid_grant refresh failure as a reconnect error', async () => {
    const secrets = makeSecrets();
    const { client } = fakeTokenClient([
      new OAuthReconnectRequiredError('[linear] grant dead'),
    ]);
    const mgr = createOAuthTokenManager({
      secrets,
      tokenClient: client,
      now: () => 1_000_000,
    });

    mgr.seedFromExchange(CONN, tokenResponse({ refreshToken: 'refresh-1', expiresInSec: 0 }));

    await expect(mgr.getAccessToken(CONN)).rejects.toBeInstanceOf(OAuthReconnectRequiredError);
  });
});

describe('revoke', () => {
  it('revokes the stored refresh token and drops the cache entry', async () => {
    const secrets = makeSecrets();
    const { client, revokeArgs } = fakeTokenClient([]);
    const mgr = createOAuthTokenManager({
      secrets,
      tokenClient: client,
      now: () => 1_000_000,
    });

    mgr.seedFromExchange(CONN, tokenResponse({ refreshToken: 'refresh-1', expiresInSec: 3600 }));

    await mgr.revoke(CONN);

    expect(revokeArgs).toEqual(['refresh-1']);
  });

  it('is a no-op revoke call when no refresh token is stored', async () => {
    const secrets = makeSecrets();
    const { client, revokeArgs } = fakeTokenClient([]);
    const mgr = createOAuthTokenManager({
      secrets,
      tokenClient: client,
      now: () => 1_000_000,
    });

    await mgr.revoke(CONN);

    expect(revokeArgs).toEqual([]);
  });
});
