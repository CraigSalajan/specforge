import { ipcMain } from 'electron';
import {
  getAllSettings,
  getSetting,
  setSetting,
  setManySettings,
} from '../db/repositories/settings.repo';
import {
  decryptSettingValue,
  encryptSettingValue,
  isConnectionSecretKey,
} from './secure-settings';

const Channels = {
  Get: 'specforge:settings-get',
  GetAll: 'specforge:settings-get-all',
  Set: 'specforge:settings-set',
  SetMany: 'specforge:settings-set-many',
} as const;

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
    throw new Error('Invalid settings key');
  }
}

function assertValue(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error('Settings values must be strings');
  }
}

export function registerSettingsHandlers(): void {
  ipcMain.handle(Channels.Get, async (_e, key: string): Promise<string | null> => {
    assertKey(key);
    const stored = getSetting(key);
    return stored === null ? null : decryptSettingValue(key, stored);
  });

  ipcMain.handle(Channels.GetAll, async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(getAllSettings())) {
      if (isConnectionSecretKey(k)) continue; // per-connection secrets are read main-side only (TER-28)
      out[k] = decryptSettingValue(k, v);
    }
    return out;
  });

  ipcMain.handle(Channels.Set, async (_e, key: string, value: string): Promise<void> => {
    assertKey(key);
    assertValue(value);
    setSetting(key, encryptSettingValue(key, value));
  });

  ipcMain.handle(
    Channels.SetMany,
    async (_e, values: Record<string, string>): Promise<void> => {
      if (typeof values !== 'object' || values === null) {
        throw new Error('Invalid settings payload');
      }
      const sanitized: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        assertKey(k);
        assertValue(v);
        sanitized[k] = encryptSettingValue(k, v);
      }
      setManySettings(sanitized);
    },
  );
}
