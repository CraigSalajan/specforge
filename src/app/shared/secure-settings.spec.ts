import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the at-rest secret encryption seam (TER-28 widens it to the
 * per-connection PM credential keys `linear.pat::<id>` / `linear.refreshToken::<id>`).
 *
 * Only `electron`'s `safeStorage` is mocked — a *reversible* cipher so encrypt →
 * decrypt round-trips deterministically. The repo-dependent migration takes an
 * injected {@link SecretSettingsStore}, so this spec backs it with an in-memory
 * Map and never imports the SQLite-backed repository (or the `node:sqlite`
 * built-in the renderer test bundler cannot bundle).
 */
const { safeStorageMock } = vi.hoisted(() => ({
  safeStorageMock: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from('cipher:' + s)),
    decryptString: vi.fn((b: Buffer) => b.toString().replace(/^cipher:/, '')),
  },
}));

vi.mock('electron', () => ({ safeStorage: safeStorageMock }));

import {
  decryptSettingValue,
  encryptSettingValue,
  isConnectionSecretKey,
  isSecretSettingKey,
  migratePlaintextSecrets,
  type SecretSettingsStore,
} from '../../../electron/ipc/secure-settings';

const ENC_PREFIX = 'enc:v1:';
const CONN_PAT_KEY = 'linear.pat::linear-abc';
const CONN_REFRESH_KEY = 'linear.refreshToken::linear-abc';

// In-memory SecretSettingsStore backing the migration tests; `backing` is read
// directly to assert what landed at rest.
const backing = new Map<string, string>();
const store: SecretSettingsStore = {
  get: (k) => (backing.has(k) ? backing.get(k)! : null),
  set: (k, v) => {
    backing.set(k, v);
  },
  getAll: () => Object.fromEntries(backing),
};

beforeEach(() => {
  backing.clear();
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  safeStorageMock.encryptString.mockClear();
  safeStorageMock.decryptString.mockClear();
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
    backing.set(CONN_PAT_KEY, 'plain-pat');
    backing.set('linear.pat', 'plain-global-pat');

    migratePlaintextSecrets(store);

    const migratedConn = backing.get(CONN_PAT_KEY)!;
    const migratedGlobal = backing.get('linear.pat')!;
    expect(migratedConn.startsWith(ENC_PREFIX)).toBe(true);
    expect(migratedGlobal.startsWith(ENC_PREFIX)).toBe(true);
    expect(decryptSettingValue(CONN_PAT_KEY, migratedConn)).toBe('plain-pat');
    expect(decryptSettingValue('linear.pat', migratedGlobal)).toBe('plain-global-pat');
  });

  it('skips already-encrypted rows, empty rows and non-secret rows', () => {
    const alreadyEncrypted = encryptSettingValue(CONN_PAT_KEY, 'already');
    backing.set(CONN_PAT_KEY, alreadyEncrypted);
    backing.set(CONN_REFRESH_KEY, '');
    backing.set('pm.connections', '{"C:/Vault":[]}'); // non-secret, must stay plaintext

    migratePlaintextSecrets(store);

    expect(backing.get(CONN_PAT_KEY)).toBe(alreadyEncrypted); // untouched, not double-encrypted
    expect(backing.get(CONN_REFRESH_KEY)).toBe(''); // empty stays empty
    expect(backing.get('pm.connections')).toBe('{"C:/Vault":[]}'); // never encrypted
  });

  it('is a no-op when OS encryption is unavailable', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    backing.set(CONN_PAT_KEY, 'plain-pat');

    migratePlaintextSecrets(store);

    expect(backing.get(CONN_PAT_KEY)).toBe('plain-pat'); // left as plaintext
  });
});
