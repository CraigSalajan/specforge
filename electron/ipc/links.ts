import { ipcMain } from 'electron';
import * as path from 'node:path';
import {
  listBacklinks,
  listOutgoingLinks,
  type BacklinkRow,
  type OutgoingLinkRow,
} from '../db/repositories/links.repo';
import { listFileRelPaths } from '../db/repositories/files.repo';
import { resolveLinkTarget } from '../indexing/link-resolver';
import { normalizeWikiTarget } from '../indexing/link-parser';

const Channels = {
  Backlinks: 'specforge:links-backlinks',
  Outgoing: 'specforge:links-outgoing',
  Resolve: 'specforge:links-resolve',
} as const;

const MAX_TARGET_LENGTH = 1024;

function assertVaultPath(vaultPath: unknown): string {
  if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
    throw new Error('Invalid vault path');
  }
  return path.resolve(vaultPath);
}

/**
 * Forward-slash normalize, strip leading/trailing slashes, reject `..`/`.` so
 * the rel path can never address anything outside the vault (mirrors the
 * sanitizer in `ipc/index.ts`).
 */
function assertRelPath(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('Invalid vault-relative path');
  }
  const normalized = input.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error('Invalid vault-relative path');
  }
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error('Invalid vault-relative path');
    }
  }
  return segments.join('/');
}

function assertLinkTarget(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_TARGET_LENGTH) {
    throw new Error('Invalid link target');
  }
  return input;
}

export function registerLinkHandlers(): void {
  ipcMain.handle(
    Channels.Backlinks,
    async (_e, vaultPath: string, relPath: string): Promise<BacklinkRow[]> => {
      const vault = assertVaultPath(vaultPath);
      const rel = assertRelPath(relPath);
      return listBacklinks(vault, rel);
    },
  );

  ipcMain.handle(
    Channels.Outgoing,
    async (_e, vaultPath: string, relPath: string): Promise<OutgoingLinkRow[]> => {
      const vault = assertVaultPath(vaultPath);
      const rel = assertRelPath(relPath);
      return listOutgoingLinks(vault, rel);
    },
  );

  ipcMain.handle(
    Channels.Resolve,
    async (_e, vaultPath: string, target: string): Promise<string | null> => {
      const vault = assertVaultPath(vaultPath);
      // Tolerate full wikilink inner text (alias/fragment) from editor clicks.
      const normalized = normalizeWikiTarget(assertLinkTarget(target));
      if (normalized.length === 0) return null;
      return resolveLinkTarget(normalized, listFileRelPaths(vault));
    },
  );
}
