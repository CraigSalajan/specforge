import { ipcMain } from 'electron';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { rebuildIndex, getIndexStatus, type IndexStatus } from '../indexing/indexer';
import { searchChunks, type SearchHit } from '../db/repositories/chunks.repo';

const Channels = {
  Rebuild: 'specforge:index-rebuild',
  Status: 'specforge:index-status',
  Search: 'specforge:index-search',
} as const;

async function assertVaultPath(vaultPath: unknown): Promise<string> {
  if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
    throw new Error('Invalid vault path');
  }
  const resolved = path.resolve(vaultPath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error('Vault path is not a directory');
  }
  return resolved;
}

function assertVaultPathSync(vaultPath: unknown): string {
  if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
    throw new Error('Invalid vault path');
  }
  return path.resolve(vaultPath);
}

const MAX_FILTER_ENTRIES = 200;

/** Forward-slash normalize, strip leading/trailing slashes, reject `..`/`.`. */
function canonicalRelPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const normalized = input.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return null;
  }
  return segments.join('/');
}

function sanitizePathArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= MAX_FILTER_ENTRIES) break;
    const canon = canonicalRelPath(entry);
    if (canon !== null) out.push(canon);
  }
  return out;
}

function sanitizeFilter(
  value: unknown,
): { folders: string[]; files: string[] } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { folders?: unknown; files?: unknown };
  const folders = sanitizePathArray(v.folders);
  const files = sanitizePathArray(v.files);
  if (folders.length === 0 && files.length === 0) return undefined;
  return { folders, files };
}

export function registerIndexHandlers(): void {
  ipcMain.handle(
    Channels.Rebuild,
    async (_e, vaultPath: string): Promise<IndexStatus> => {
      const resolved = await assertVaultPath(vaultPath);
      await rebuildIndex(resolved);
      return getIndexStatus(resolved);
    },
  );

  ipcMain.handle(Channels.Status, async (_e, vaultPath: string): Promise<IndexStatus> => {
    const resolved = assertVaultPathSync(vaultPath);
    return getIndexStatus(resolved);
  });

  ipcMain.handle(
    Channels.Search,
    async (
      _e,
      vaultPath: string,
      query: string,
      limit: number,
      filter?: unknown,
    ): Promise<SearchHit[]> => {
      const resolved = assertVaultPathSync(vaultPath);
      if (typeof query !== 'string') throw new Error('Invalid search query');
      const lim = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 20;
      return searchChunks(resolved, query, lim, sanitizeFilter(filter));
    },
  );
}
