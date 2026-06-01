import { ipcMain } from 'electron';
import * as path from 'node:path';
import {
  latestApplied,
  listChanges,
  markApplied,
  recordChange,
  type AiChangeType,
  type RecordChangeInput,
} from '../db/repositories/ai-changes.repo';

const Channels = {
  List: 'specforge:ai-history-list',
  Record: 'specforge:ai-history-record',
  MarkApplied: 'specforge:ai-history-mark-applied',
  LatestApplied: 'specforge:ai-history-latest-applied',
} as const;

const ALLOWED_TYPES = new Set<AiChangeType>(['create', 'edit', 'rename', 'delete']);

function assertVaultPath(vaultPath: unknown): string {
  if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
    throw new Error('Invalid vault path');
  }
  return path.resolve(vaultPath);
}

function assertNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function assertRelPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function assertNullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  return value;
}

interface RecordPayload {
  sessionId: number | null;
  vaultPath: string;
  relPath: string;
  newRelPath?: string | null;
  changeType: string;
  beforeContent: string | null;
  afterContent: string | null;
  applied: boolean;
}

export function registerAiHistoryHandlers(): void {
  ipcMain.handle(Channels.List, async (_e, vaultPath: string, limit: number) => {
    const resolved = assertVaultPath(vaultPath);
    const lim = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 50;
    return listChanges(resolved, lim);
  });

  ipcMain.handle(Channels.Record, async (_e, input: RecordPayload) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid payload');
    const resolved = assertVaultPath(input.vaultPath);
    if (typeof input.changeType !== 'string' || !ALLOWED_TYPES.has(input.changeType as AiChangeType)) {
      throw new Error('Invalid changeType');
    }
    const payload: RecordChangeInput = {
      sessionId: input.sessionId === null || input.sessionId === undefined
        ? null
        : assertNumber(input.sessionId, 'sessionId'),
      vaultPath: resolved,
      relPath: assertRelPath(input.relPath, 'relPath'),
      newRelPath: input.newRelPath === null || input.newRelPath === undefined
        ? null
        : assertRelPath(input.newRelPath, 'newRelPath'),
      changeType: input.changeType as AiChangeType,
      beforeContent: assertNullableString(input.beforeContent, 'beforeContent'),
      afterContent: assertNullableString(input.afterContent, 'afterContent'),
      applied: Boolean(input.applied),
    };
    return recordChange(payload);
  });

  ipcMain.handle(Channels.MarkApplied, async (_e, id: number, applied: boolean) => {
    const cid = assertNumber(id, 'id');
    markApplied(cid, Boolean(applied));
  });

  ipcMain.handle(Channels.LatestApplied, async (_e, vaultPath: string) => {
    const resolved = assertVaultPath(vaultPath);
    return latestApplied(resolved);
  });
}
