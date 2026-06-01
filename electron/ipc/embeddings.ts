import { ipcMain } from 'electron';
import * as path from 'node:path';
import {
  clearEmbeddings,
  listPendingChunks,
  searchByVector,
  upsertEmbeddings,
  type UpsertItem,
} from '../db/repositories/embeddings.repo';

const Channels = {
  Upsert: 'specforge:embeddings-upsert',
  Search: 'specforge:embeddings-search',
  ListPending: 'specforge:embeddings-list-pending-chunks',
  Clear: 'specforge:embeddings-clear',
} as const;

function assertVaultPath(vaultPath: unknown): string {
  if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
    throw new Error('Invalid vault path');
  }
  return path.resolve(vaultPath);
}

function assertString(value: unknown, label: string, maxLen = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLen) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function assertNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
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

function assertVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Invalid vector');
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'number' || !Number.isFinite(value[i])) {
      throw new Error('Vector contains non-numeric value');
    }
  }
  return value as number[];
}

interface UpsertPayload {
  items: Array<{ chunkId: number; model: string; vector: number[]; dim: number }>;
}

export function registerEmbeddingHandlers(): void {
  ipcMain.handle(
    Channels.Upsert,
    async (_e, payload: UpsertPayload | UpsertPayload['items']): Promise<{ written: number }> => {
      const items = Array.isArray(payload) ? payload : payload?.items;
      if (!Array.isArray(items)) throw new Error('Invalid embeddings payload');
      const sanitized: UpsertItem[] = items.map((it) => ({
        chunkId: assertNumber(it.chunkId, 'chunkId'),
        model: assertString(it.model, 'model'),
        vector: assertVector(it.vector),
        dim: assertNumber(it.dim, 'dim'),
      }));
      const written = upsertEmbeddings(sanitized);
      return { written };
    },
  );

  ipcMain.handle(
    Channels.Search,
    async (
      _e,
      input: {
        vaultPath: string;
        vector: number[];
        limit: number;
        model: string;
        filter?: unknown;
      },
    ) => {
      if (!input || typeof input !== 'object') throw new Error('Invalid payload');
      const resolved = assertVaultPath(input.vaultPath);
      const vec = assertVector(input.vector);
      const model = assertString(input.model, 'model');
      const limit = assertNumber(input.limit, 'limit');
      return searchByVector(resolved, vec, model, Math.floor(limit), sanitizeFilter(input.filter));
    },
  );

  ipcMain.handle(
    Channels.ListPending,
    async (_e, input: { vaultPath: string; model: string; limit: number }) => {
      if (!input || typeof input !== 'object') throw new Error('Invalid payload');
      const resolved = assertVaultPath(input.vaultPath);
      const model = assertString(input.model, 'model');
      const limit = assertNumber(input.limit, 'limit');
      return listPendingChunks(resolved, model, Math.floor(limit));
    },
  );

  ipcMain.handle(
    Channels.Clear,
    async (_e, input: { vaultPath: string; model?: string }): Promise<{ removed: number }> => {
      if (!input || typeof input !== 'object') throw new Error('Invalid payload');
      const resolved = assertVaultPath(input.vaultPath);
      const model = input.model ? assertString(input.model, 'model') : undefined;
      const removed = clearEmbeddings(resolved, model);
      return { removed };
    },
  );
}
