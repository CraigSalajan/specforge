import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the at-rest secret encryption seam (TER-28 widens it to the
 * per-connection PM credential keys `linear.pat::<id>` / `linear.refreshToken::<id>`).
 *
 * `electron`'s `safeStorage` is faked with a *reversible* cipher so encrypt →
 * decrypt round-trips deterministically, and the settings repo is backed by an
 * in-memory Map so `getAllSettings`/`setSetting` actually persist within a test
 * (the real repo needs a SQLite handle that does not exist under the renderer's
 * test runner).
 */

// The Angular unit-test builder rejects relative `vi.mock` specifiers (its
// `vitest-mock-patch` throws for any path starting with `.`/`/`), so the settings
// repo is exercised for real against a faked `node:sqlite` — a bare specifier the
// patch allows. `node:sqlite` is declared in `angular.json` `externalDependencies`
// so the client test bundler leaves the built-in external (it cannot bundle it);
// this mock then supplies a `DatabaseSync` backed by `store` (the `settings`
// table). Everything the hoisted factories reference must live in `vi.hoisted`
// (it runs before the module's imports).
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

import {
  decryptSettingValue,
  encryptSettingValue,
  isConnectionSecretKey,
  isSecretSettingKey,
  migratePlaintextSecrets,
} from '../../../electron/ipc/secure-settings';

const ENC_PREFIX = 'enc:v1:';
const CONN_PAT_KEY = 'linear.pat::linear-abc';
const CONN_REFRESH_KEY = 'linear.refreshToken::linear-abc';

beforeEach(() => {
  store.clear();
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  safeStorageMock.encryptString.mockClear();
  safeStorageMock.decryptString.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('isSecretSettingKey / isConnectionSecretKey', () => {
  it('treats both the bare and per-connection secret keys as secret', () => {
    expect(isSecretSettingKey('ai.apiKey')).toBe(true);
    expect(isSecretSettingKey('linear.pat')).toBe(true);
    expect(isSecretSettingKey(CONN_PAT_KEY)).toBe(true);
    expect(isSecretSettingKey(CONN_REFRESH_KEY)).toBe(true);
  });

  it('treats non-secret keys as non-secret', () => {
    expect(isSecretSettingKey('ai.baseUrl')).toBe(false);
    expect(isSecretSettingKey('pm.connections')).toBe(false);
  });

  it('only the per-connection keys are connection-secret keys', () => {
    expect(isConnectionSecretKey(CONN_PAT_KEY)).toBe(true);
    expect(isConnectionSecretKey(CONN_REFRESH_KEY)).toBe(true);
    // Bare secret keys are encrypted but NOT per-connection (they still hydrate).
    expect(isConnectionSecretKey('ai.apiKey')).toBe(false);
    expect(isConnectionSecretKey('linear.pat')).toBe(false);
    expect(isConnectionSecretKey('pm.connections')).toBe(false);
  });
});

describe('encryptSettingValue / decryptSettingValue', () => {
  it('round-trips a per-connection key through enc:v1:', () => {
    const encrypted = encryptSettingValue(CONN_PAT_KEY, 'lin_api_secret');
    expect(encrypted.startsWith(ENC_PREFIX)).toBe(true);
    expect(encrypted).not.toContain('lin_api_secret');
    expect(decryptSettingValue(CONN_PAT_KEY, encrypted)).toBe('lin_api_secret');
  });

  it('passes an empty value through unchanged (empty is "unset")', () => {
    expect(encryptSettingValue(CONN_PAT_KEY, '')).toBe('');
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });

  it('passes through as plaintext when OS encryption is unavailable', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(encryptSettingValue(CONN_PAT_KEY, 'lin_api_secret')).toBe('lin_api_secret');
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });

  it('passes a non-enc: stored value through on decrypt (legacy plaintext row)', () => {
    expect(decryptSettingValue(CONN_PAT_KEY, 'plaintext-legacy')).toBe('plaintext-legacy');
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
  });

  it('treats a value that fails to decrypt as unset ("")', () => {
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('corrupt');
    });
    expect(decryptSettingValue(CONN_PAT_KEY, ENC_PREFIX + 'garbage')).toBe('');
  });
});

describe('migratePlaintextSecrets', () => {
  it('encrypts plaintext per-connection AND legacy global linear.pat rows in place', () => {
    store.set(CONN_PAT_KEY, 'plain-pat');
    store.set('linear.pat', 'plain-global-pat');

    migratePlaintextSecrets();

    const migratedConn = store.get(CONN_PAT_KEY)!;
    const migratedGlobal = store.get('linear.pat')!;
    expect(migratedConn.startsWith(ENC_PREFIX)).toBe(true);
    expect(migratedGlobal.startsWith(ENC_PREFIX)).toBe(true);
    expect(decryptSettingValue(CONN_PAT_KEY, migratedConn)).toBe('plain-pat');
    expect(decryptSettingValue('linear.pat', migratedGlobal)).toBe('plain-global-pat');
  });

  it('skips already-encrypted rows, empty rows and non-secret rows', () => {
    const alreadyEncrypted = encryptSettingValue(CONN_PAT_KEY, 'already');
    store.set(CONN_PAT_KEY, alreadyEncrypted);
    store.set(CONN_REFRESH_KEY, '');
    store.set('pm.connections', '{"C:/Vault":[]}'); // non-secret, must stay plaintext

    migratePlaintextSecrets();

    expect(store.get(CONN_PAT_KEY)).toBe(alreadyEncrypted); // untouched, not double-encrypted
    expect(store.get(CONN_REFRESH_KEY)).toBe(''); // empty stays empty
    expect(store.get('pm.connections')).toBe('{"C:/Vault":[]}'); // never encrypted
  });

  it('is a no-op when OS encryption is unavailable', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    store.set(CONN_PAT_KEY, 'plain-pat');

    migratePlaintextSecrets();

    expect(store.get(CONN_PAT_KEY)).toBe('plain-pat'); // left as plaintext
  });
});
