import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the per-connection PM credential store (TER-28).
 *
 * `electron`'s `safeStorage` is faked with a reversible cipher (so encrypt →
 * decrypt round-trips), and the settings repo is backed by an in-memory Map so
 * the store actually persists within a test. Asserting against the Map directly
 * lets us prove rows are `enc:v1:`-prefixed *at rest*, while the public getters
 * return plaintext.
 */

// The Angular unit-test builder rejects relative `vi.mock` specifiers (its
// `vitest-mock-patch` throws for any path starting with `.`/`/`), so the settings
// repo is exercised for real against a faked `node:sqlite` — a bare specifier the
// patch allows. The DB module loads `node:sqlite` lazily (see `electron/db/index.ts`),
// so it never enters the Vite test bundle; this mock supplies a `DatabaseSync`
// backed by `store` (the `settings` table). Everything the hoisted factories
// reference must live in `vi.hoisted` (it runs before the module's imports).
const { store, safeStorageMock, FakeDatabaseSync } = vi.hoisted(() => {
  const backing = new Map<string, string>();
  const ss = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from('cipher:' + s)),
    decryptString: vi.fn((b: Buffer) => b.toString().replace(/^cipher:/, '')),
  };

  // Minimal `DatabaseSync` answering only the SQL the settings repo + DB
  // bootstrap issue, all backed by `backing` (the `settings` table).
  class FakeDb {
    constructor(_path: string) {}
    exec(_sql: string): void {}
    prepare(sql: string) {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (q.startsWith('SELECT value FROM settings WHERE key = ?')) {
        return {
          get: (key: string) => (backing.has(key) ? { value: backing.get(key) } : undefined),
          all: () => [],
          run: () => ({ changes: 0 }),
        };
      }
      if (q.startsWith('SELECT key, value FROM settings')) {
        return {
          get: () => undefined,
          all: () => [...backing.entries()].map(([key, value]) => ({ key, value })),
          run: () => ({ changes: 0 }),
        };
      }
      if (q.startsWith('INSERT INTO settings')) {
        return {
          get: () => undefined,
          all: () => [],
          run: (key: string, value: string) => {
            backing.set(key, value);
            return { changes: 1 };
          },
        };
      }
      // DB bootstrap queries (_migrations, sqlite_master) — answered as fresh DB.
      return { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) };
    }
    close(): void {}
  }

  return { store: backing, safeStorageMock: ss, FakeDatabaseSync: FakeDb };
});

// `getPath` returns '.' (an always-existing dir) so `getDb()` skips the mkdir;
// the fake DB ignores the path, so no file is ever created.
vi.mock('electron', () => ({ safeStorage: safeStorageMock, app: { getPath: () => '.' } }));
vi.mock('node:sqlite', () => ({
  DatabaseSync: FakeDatabaseSync,
  default: { DatabaseSync: FakeDatabaseSync },
}));

import { initDb } from '../../../electron/db/index';
import {
  connectionSecretKey,
  connectionTokenSource,
  deleteConnectionSecrets,
  getConnectionToken,
  hasConnectionToken,
  setConnectionToken,
} from '../../../electron/sync/connection-secrets';

const ENC_PREFIX = 'enc:v1:';
// Two distinct connectionIds — modelling two vaults pointed at the same team.
const CONN_A = 'linear-aaaaaaaaaaaaaaaa';
const CONN_B = 'linear-bbbbbbbbbbbbbbbb';

beforeEach(async () => {
  store.clear();
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  // Resolves the (faked) `node:sqlite` constructor so synchronous `getDb()`
  // calls in the repo work; idempotent across tests.
  await initDb();
});

describe('connectionSecretKey', () => {
  it('shapes the key per kind, matching the secure-settings prefixes', () => {
    expect(connectionSecretKey(CONN_A, 'pat')).toBe(`linear.pat::${CONN_A}`);
    expect(connectionSecretKey(CONN_A, 'refreshToken')).toBe(`linear.refreshToken::${CONN_A}`);
  });
});

describe('set / get round-trip', () => {
  it('round-trips a pat and a refreshToken independently for one connection', () => {
    setConnectionToken(CONN_A, 'pat', 'pat-token');
    setConnectionToken(CONN_A, 'refreshToken', 'refresh-token');

    expect(getConnectionToken(CONN_A, 'pat')).toBe('pat-token');
    expect(getConnectionToken(CONN_A, 'refreshToken')).toBe('refresh-token');
  });

  it('returns "" for an unset credential', () => {
    expect(getConnectionToken(CONN_A, 'pat')).toBe('');
  });

  it('stores the value encrypted (enc:v1:) at rest', () => {
    setConnectionToken(CONN_A, 'pat', 'pat-token');
    const atRest = store.get(connectionSecretKey(CONN_A, 'pat'))!;
    expect(atRest.startsWith(ENC_PREFIX)).toBe(true);
    expect(atRest).not.toContain('pat-token');
  });
});

describe('cross-vault isolation', () => {
  it('keeps two different connectionIds fully independent', () => {
    setConnectionToken(CONN_A, 'pat', 'token-a');
    setConnectionToken(CONN_B, 'pat', 'token-b');

    expect(getConnectionToken(CONN_A, 'pat')).toBe('token-a');
    expect(getConnectionToken(CONN_B, 'pat')).toBe('token-b');

    // Clearing one never affects the other.
    deleteConnectionSecrets(CONN_A);
    expect(getConnectionToken(CONN_A, 'pat')).toBe('');
    expect(getConnectionToken(CONN_B, 'pat')).toBe('token-b');
  });
});

describe('hasConnectionToken', () => {
  it('reflects set then clear', () => {
    expect(hasConnectionToken(CONN_A, 'pat')).toBe(false);
    setConnectionToken(CONN_A, 'pat', 'pat-token');
    expect(hasConnectionToken(CONN_A, 'pat')).toBe(true);
    setConnectionToken(CONN_A, 'pat', '');
    expect(hasConnectionToken(CONN_A, 'pat')).toBe(false);
  });
});

describe('clearing credentials', () => {
  it('setConnectionToken(..., "") clears a single credential', () => {
    setConnectionToken(CONN_A, 'pat', 'pat-token');
    setConnectionToken(CONN_A, 'pat', '');
    expect(getConnectionToken(CONN_A, 'pat')).toBe('');
  });

  it('deleteConnectionSecrets clears BOTH kinds', () => {
    setConnectionToken(CONN_A, 'pat', 'pat-token');
    setConnectionToken(CONN_A, 'refreshToken', 'refresh-token');

    deleteConnectionSecrets(CONN_A);

    expect(getConnectionToken(CONN_A, 'pat')).toBe('');
    expect(getConnectionToken(CONN_A, 'refreshToken')).toBe('');
    expect(hasConnectionToken(CONN_A, 'pat')).toBe(false);
    expect(hasConnectionToken(CONN_A, 'refreshToken')).toBe(false);
  });
});

describe('connectionTokenSource', () => {
  it('resolves the stored pat by default', async () => {
    setConnectionToken(CONN_A, 'pat', 'pat-token');
    const source = connectionTokenSource(CONN_A, 'pat');
    // TokenSource is `() => string | Promise<string>`; await normalizes either.
    await expect(Promise.resolve(source())).resolves.toBe('pat-token');
  });

  it('resolves the current value on each call (picks up rotation)', async () => {
    const source = connectionTokenSource(CONN_A);
    setConnectionToken(CONN_A, 'pat', 'first');
    expect(await source()).toBe('first');
    setConnectionToken(CONN_A, 'pat', 'second');
    expect(await source()).toBe('second');
  });
});
