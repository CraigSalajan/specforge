import { ipcMain } from 'electron';
import * as path from 'node:path';
import {
  queryFilesByProperty,
  listKeys,
  listValues,
} from '../db/repositories/doc-properties.repo';

const Channels = {
  Query: 'specforge:doc-properties-query',
  Keys: 'specforge:doc-properties-keys',
  Values: 'specforge:doc-properties-values',
} as const;

const MAX_FIELD_LENGTH = 256;

function assertVaultPath(vaultPath: unknown): string {
  if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
    throw new Error('Invalid vault path');
  }
  return path.resolve(vaultPath);
}

/**
 * Guards a frontmatter key/value: a non-empty string within a sane length
 * bound so a malformed renderer call can never reach the SQL layer with an
 * unbounded payload.
 */
function assertField(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_FIELD_LENGTH) {
    throw new Error(`Invalid ${label}`);
  }
  return input;
}

export function registerDocPropertiesHandlers(): void {
  ipcMain.handle(
    Channels.Query,
    async (_e, vaultPath: string, key: string, value: string): Promise<{ relPath: string }[]> => {
      const vault = assertVaultPath(vaultPath);
      const k = assertField(key, 'property key');
      const v = assertField(value, 'property value');
      return queryFilesByProperty(vault, k, v);
    },
  );

  ipcMain.handle(Channels.Keys, async (_e, vaultPath: string): Promise<string[]> => {
    const vault = assertVaultPath(vaultPath);
    return listKeys(vault);
  });

  ipcMain.handle(
    Channels.Values,
    async (_e, vaultPath: string, key: string): Promise<string[]> => {
      const vault = assertVaultPath(vaultPath);
      const k = assertField(key, 'property key');
      return listValues(vault, k);
    },
  );
}
