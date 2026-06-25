import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the per-connection PM credential store (TER-28).
 *
 * Only `electron`'s `safeStorage` is mocked (a reversible cipher so encrypt →
 * decrypt round-trips). The store is built via {@link createConnectionSecrets}
 * over an in-memory Map, so this spec never imports the SQLite-backed repository
 * (or the `node:sqlite` built-in the renderer test bundler cannot bundle).
 * Asserting against the Map directly proves rows are `enc:v1:`-prefixed *at
 * rest*, while the getters return plaintext.
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
  connectionSecretKey,
  createConnectionSecrets,
  type ConnectionSecrets,
} from '../../../electron/sync/connection-secrets';
import type { SecretSettingsStore } from '../../../electron/ipc/secure-settings';

const ENC_PREFIX = 'enc:v1:';
// Two distinct connectionIds — modelling two vaults pointed at the same team.
const CONN_A = 'linear-aaaaaaaaaaaaaaaa';
const CONN_B = 'linear-bbbbbbbbbbbbbbbb';

const backing = new Map<string, string>();
const store: SecretSettingsStore = {
  get: (k) => (backing.has(k) ? backing.get(k)! : null),
  set: (k, v) => {
    backing.set(k, v);
  },
  getAll: () => Object.fromEntries(backing),
};
let secrets: ConnectionSecrets;

beforeEach(() => {
  backing.clear();
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  secrets = createConnectionSecrets(store);
});

describe('connectionSecretKey', () => {
  it('shapes the key per kind, matching the secure-settings prefixes', () => {
    expect(connectionSecretKey(CONN_A, 'pat')).toBe(`linear.pat::${CONN_A}`);
    expect(connectionSecretKey(CONN_A, 'refreshToken')).toBe(`linear.refreshToken::${CONN_A}`);
  });
});

describe('set / get round-trip', () => {
  it('round-trips a pat and a refreshToken independently for one connection', () => {
    secrets.setConnectionToken(CONN_A, 'pat', 'pat-token');
    secrets.setConnectionToken(CONN_A, 'refreshToken', 'refresh-token');

    expect(secrets.getConnectionToken(CONN_A, 'pat')).toBe('pat-token');
    expect(secrets.getConnectionToken(CONN_A, 'refreshToken')).toBe('refresh-token');
  });

  it('returns "" for an unset credential', () => {
    expect(secrets.getConnectionToken(CONN_A, 'pat')).toBe('');
  });

  it('stores the value encrypted (enc:v1:) at rest', () => {
    secrets.setConnectionToken(CONN_A, 'pat', 'pat-token');
    const atRest = backing.get(connectionSecretKey(CONN_A, 'pat'))!;
    expect(atRest.startsWith(ENC_PREFIX)).toBe(true);
    expect(atRest).not.toContain('pat-token');
  });
});

describe('cross-vault isolation', () => {
  it('keeps two different connectionIds fully independent', () => {
    secrets.setConnectionToken(CONN_A, 'pat', 'token-a');
    secrets.setConnectionToken(CONN_B, 'pat', 'token-b');

    expect(secrets.getConnectionToken(CONN_A, 'pat')).toBe('token-a');
    expect(secrets.getConnectionToken(CONN_B, 'pat')).toBe('token-b');

    // Clearing one never affects the other.
    secrets.deleteConnectionSecrets(CONN_A);
    expect(secrets.getConnectionToken(CONN_A, 'pat')).toBe('');
    expect(secrets.getConnectionToken(CONN_B, 'pat')).toBe('token-b');
  });
});

describe('hasConnectionToken', () => {
  it('reflects set then clear', () => {
    expect(secrets.hasConnectionToken(CONN_A, 'pat')).toBe(false);
    secrets.setConnectionToken(CONN_A, 'pat', 'pat-token');
    expect(secrets.hasConnectionToken(CONN_A, 'pat')).toBe(true);
    secrets.setConnectionToken(CONN_A, 'pat', '');
    expect(secrets.hasConnectionToken(CONN_A, 'pat')).toBe(false);
  });
});

describe('clearing credentials', () => {
  it('setConnectionToken(..., "") clears a single credential', () => {
    secrets.setConnectionToken(CONN_A, 'pat', 'pat-token');
    secrets.setConnectionToken(CONN_A, 'pat', '');
    expect(secrets.getConnectionToken(CONN_A, 'pat')).toBe('');
  });

  it('deleteConnectionSecrets clears BOTH kinds', () => {
    secrets.setConnectionToken(CONN_A, 'pat', 'pat-token');
    secrets.setConnectionToken(CONN_A, 'refreshToken', 'refresh-token');

    secrets.deleteConnectionSecrets(CONN_A);

    expect(secrets.getConnectionToken(CONN_A, 'pat')).toBe('');
    expect(secrets.getConnectionToken(CONN_A, 'refreshToken')).toBe('');
    expect(secrets.hasConnectionToken(CONN_A, 'pat')).toBe(false);
    expect(secrets.hasConnectionToken(CONN_A, 'refreshToken')).toBe(false);
  });
});

describe('connectionTokenSource', () => {
  it('resolves the stored pat by default', async () => {
    secrets.setConnectionToken(CONN_A, 'pat', 'pat-token');
    const source = secrets.connectionTokenSource(CONN_A, 'pat');
    // TokenSource is `() => string | Promise<string>`; await normalizes either.
    await expect(Promise.resolve(source())).resolves.toBe('pat-token');
  });

  it('resolves the current value on each call (picks up rotation)', async () => {
    const source = secrets.connectionTokenSource(CONN_A);
    secrets.setConnectionToken(CONN_A, 'pat', 'first');
    expect(await source()).toBe('first');
    secrets.setConnectionToken(CONN_A, 'pat', 'second');
    expect(await source()).toBe('second');
  });
});
