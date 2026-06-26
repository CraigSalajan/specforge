import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the OAuth token manager (TER-33). Only `electron`'s
 * `safeStorage` is mocked (a reversible cipher) so the real
 * {@link createConnectionSecrets} can persist over an in-memory Map — proving the
 * ROTATED refresh token is actually written back through the secret store, not
 * just held in memory. The token client is a hand-rolled fake recording refreshes.
 */
// The unit-test builder bundles every spec into ONE module graph, so the modules
// under test bind to a SINGLE `electron` mock across the whole bundle. Share one
// safeStorage mock instance via globalThis so that — whichever file's vi.mock factory
// wins the binding — every spec mutates the same object. Otherwise a per-file mock's
// isEncryptionAvailable override is invisible to the bound module and the suite flakes
// order-dependently (green locally, red on CI).
const { safeStorageMock } = vi.hoisted(() => {
  const g = globalThis as typeof globalThis & {
    __sfSafeStorageMock__?: {
      isEncryptionAvailable: ReturnType<typeof vi.fn>;
      encryptString: ReturnType<typeof vi.fn>;
      decryptString: ReturnType<typeof vi.fn>;
    };
  };
  g.__sfSafeStorageMock__ ??= {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from('cipher:' + s)),
    decryptString: vi.fn((b: Buffer) => b.toString().replace(/^cipher:/, '')),
  };
  return { safeStorageMock: g.__sfSafeStorageMock__ };
});

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

  it('does not let a refresh resolving after revoke() resurrect the connection', async () => {
    const secrets = makeSecrets();

    // A token client whose single refresh is held open by a deferred promise, so
    // we can interleave revoke() between the refresh-token read and its resolution.
    let resolveRefresh!: (res: OAuthTokenResponse) => void;
    const refreshArgs: string[] = [];
    const revokeArgs: string[] = [];
    const client = {
      exchangeCode: () => Promise.reject(new Error('not used')),
      refresh: (refreshToken: string): Promise<OAuthTokenResponse> => {
        refreshArgs.push(refreshToken);
        return new Promise<OAuthTokenResponse>((resolve) => {
          resolveRefresh = resolve;
        });
      },
      revoke: (token: string): Promise<void> => {
        revokeArgs.push(token);
        return Promise.resolve();
      },
    } as unknown as LinearTokenClient;

    const mgr = createOAuthTokenManager({ secrets, tokenClient: client, now: () => 1_000_000 });

    // Seed an already-expired token so the next read forces a refresh.
    mgr.seedFromExchange(CONN, tokenResponse({ refreshToken: 'refresh-1', expiresInSec: 0 }));

    // Kick off the refresh (reads refresh-1, snapshots the generation, then awaits).
    const accessPromise = mgr.getAccessToken(CONN);
    await Promise.resolve(); // let doRefresh run up to its awaited network call
    expect(refreshArgs).toEqual(['refresh-1']);

    // Revoke while the refresh is still in flight; revoke() awaits the pending refresh.
    const revokePromise = mgr.revoke(CONN);

    // Now let the (now-stale) refresh resolve with a freshly-rotated token.
    resolveRefresh(tokenResponse({ accessToken: 'access-late', refreshToken: 'rotated-late' }));

    // The refresh's late write must be discarded — it rejects as reconnect-required.
    await expect(accessPromise).rejects.toBeInstanceOf(OAuthReconnectRequiredError);
    await revokePromise;

    // The rotated token must NOT have been persisted: the store still holds the
    // pre-rotation value (revoke clears the cache, not the persisted secret — the
    // disconnect path does that), proving the stale write was dropped.
    expect(secrets.getConnectionToken(CONN, 'refreshToken')).toBe('refresh-1');
    // The original stored token was revoked at Linear; the rotated one never was.
    expect(revokeArgs).toEqual(['refresh-1']);
  });
});
