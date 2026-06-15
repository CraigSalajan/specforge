import { safeStorage } from 'electron';
import { getSetting, setSetting } from '../db/repositories/settings.repo';

/**
 * Transparent at-rest encryption for secret settings values.
 *
 * The renderer contract is unchanged: `settings:get`/`settings:get-all`
 * return plaintext and `settings:set`/`settings:set-many` accept plaintext.
 * Encryption happens only at the storage boundary in the settings IPC layer,
 * keeping the repository a dumb key/value store.
 *
 * Encrypted values are stored as `enc:v1:<base64(safeStorage ciphertext)>`.
 * When OS-level encryption is unavailable (some Linux setups without a
 * keyring), values degrade gracefully to plaintext — the key is never lost.
 */

const ENC_PREFIX = 'enc:v1:';

/** Settings keys whose values are encrypted at rest via `safeStorage`. */
const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set(['ai.apiKey', 'linear.pat']);

function isSecretSettingKey(key: string): boolean {
  return SECRET_SETTING_KEYS.has(key);
}

/**
 * Encrypts a secret setting value for storage. Non-secret keys, empty values
 * and environments without OS encryption pass through as plaintext.
 */
export function encryptSettingValue(key: string, value: string): string {
  if (!isSecretSettingKey(key) || value.length === 0) return value;
  if (!safeStorage.isEncryptionAvailable()) return value;
  try {
    return ENC_PREFIX + safeStorage.encryptString(value).toString('base64');
  } catch (err) {
    console.warn(`[settings] Failed to encrypt "${key}"; storing as plaintext:`, err);
    return value;
  }
}

/**
 * Decrypts a stored setting value for the renderer. Plaintext values (legacy
 * rows or no-encryption fallback) pass through unchanged. A value that fails
 * to decrypt is treated as unset (`''`) rather than crashing the settings
 * pipeline.
 */
export function decryptSettingValue(key: string, stored: string): string {
  if (!isSecretSettingKey(key) || !stored.startsWith(ENC_PREFIX)) return stored;
  try {
    const ciphertext = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    return safeStorage.decryptString(ciphertext);
  } catch (err) {
    console.warn(`[settings] Failed to decrypt "${key}"; treating it as unset:`, err);
    return '';
  }
}

/**
 * One-time migration: rewrites any plaintext secret settings in place as
 * encrypted values. Must run after the app `ready` event (a `safeStorage`
 * requirement) and after the DB has been opened. No-op when encryption is
 * unavailable or the stored values are already encrypted or empty.
 */
export function migratePlaintextSecrets(): void {
  if (!safeStorage.isEncryptionAvailable()) return;
  for (const key of SECRET_SETTING_KEYS) {
    const stored = getSetting(key);
    if (!stored || stored.startsWith(ENC_PREFIX)) continue;
    const encrypted = encryptSettingValue(key, stored);
    if (encrypted !== stored) {
      setSetting(key, encrypted);
      console.log(`[settings] Migrated "${key}" to encrypted at-rest storage.`);
    }
  }
}
