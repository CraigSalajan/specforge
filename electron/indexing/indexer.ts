import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { chunkMarkdown } from './chunker';
import { extractWikiLinks, type WikiLinkRef } from './link-parser';
import { resolveLinkTarget } from './link-resolver';
import { sha256 } from '../util/hash';
import {
  upsertFile,
  findFileByRelPath,
  listFileRelPaths,
  deleteFileByRelPath,
  countFiles,
  lastIndexedAt,
} from '../db/repositories/files.repo';
import { countChunks, replaceChunksForFile } from '../db/repositories/chunks.repo';
import {
  replaceLinksForFile,
  listStaleLinks,
  setLinkTarget,
} from '../db/repositories/links.repo';
import { replacePropertiesForFile } from '../db/repositories/doc-properties.repo';
import { parseFrontmatter, flattenProperties } from '../frontmatter/frontmatter';
import { transaction } from '../db/index';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.specforge',
  '.obsidian',
  '.vscode',
  'dist',
  'out',
]);

export interface IndexStatus {
  totalFiles: number;
  indexedFiles: number;
  totalChunks: number;
  lastIndexedAt: number | null;
}

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

function toRelPath(vaultRoot: string, absPath: string): string {
  const rel = path.relative(vaultRoot, absPath);
  // Normalize to forward slashes for stable identity across platforms.
  return rel.split(path.sep).join('/');
}

function fromRelPath(vaultRoot: string, relPath: string): string {
  return path.join(vaultRoot, relPath.split('/').join(path.sep));
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && isMarkdown(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Resolves and stores the wikilinks of a file (delete-then-insert, mirroring
 * the chunks pattern). Resolution runs against the vault's current `files`
 * rows, so it must happen after the file's own row is upserted.
 */
function storeLinksForFile(vaultRoot: string, fileId: number, refs: WikiLinkRef[]): void {
  if (refs.length === 0) {
    replaceLinksForFile(fileId, []);
    return;
  }
  const relPaths = listFileRelPaths(vaultRoot);
  replaceLinksForFile(
    fileId,
    refs.map((ref) => ({
      targetRaw: ref.target,
      targetRelPath: resolveLinkTarget(ref.target, relPaths),
      line: ref.line,
    })),
  );
}

/** Extracts and stores the frontmatter properties of a file (delete-then-insert). */
function storePropertiesForFile(fileId: number, content: string): void {
  const { data } = parseFrontmatter(content);
  replacePropertiesForFile(
    fileId,
    flattenProperties(data).map((p) => ({ key: p.key, value: p.value, idx: p.idx })),
  );
}

/**
 * Cheap vault-wide re-resolution pass: re-resolves links that never resolved
 * (NULL target) or whose resolved target no longer exists. Run after any file
 * add/delete/rename so backlinks track the current file set.
 */
export function reresolveVaultLinks(vaultRoot: string): void {
  const stale = listStaleLinks(vaultRoot);
  if (stale.length === 0) return;
  const relPaths = listFileRelPaths(vaultRoot);
  transaction(() => {
    for (const link of stale) {
      setLinkTarget(link.id, resolveLinkTarget(link.targetRaw, relPaths));
    }
  });
}

export interface IndexFileResult {
  /** True when the file row did not exist before this call. */
  created: boolean;
}

export async function indexFile(
  vaultRoot: string,
  absFilePath: string,
): Promise<IndexFileResult> {
  const stat = await fs.stat(absFilePath);
  const relPath = toRelPath(vaultRoot, absFilePath);

  // Skip if hash unchanged.
  const content = await fs.readFile(absFilePath, 'utf-8');
  const hash = sha256(content);
  const existing = findFileByRelPath(vaultRoot, relPath);
  const now = Date.now();

  if (existing && existing.hash === hash) {
    // Touch indexed_at to reflect that we checked.
    upsertFile({
      vault_path: vaultRoot,
      rel_path: relPath,
      mtime: stat.mtimeMs,
      size: stat.size,
      hash,
      indexed_at: now,
    });
    // Still refresh links: rows indexed before the links table existed would
    // otherwise never be populated (the content hash is unchanged forever).
    storeLinksForFile(vaultRoot, existing.id, extractWikiLinks(content));
    // Likewise refresh properties: rows indexed before the doc_properties table
    // existed would otherwise never be populated (the content hash is unchanged
    // forever). This backfills existing vaults.
    storePropertiesForFile(existing.id, content);
    return { created: false };
  }

  const fileId = upsertFile({
    vault_path: vaultRoot,
    rel_path: relPath,
    mtime: stat.mtimeMs,
    size: stat.size,
    hash,
    indexed_at: now,
  });

  const chunks = chunkMarkdown(content);
  replaceChunksForFile(fileId, chunks);
  storeLinksForFile(vaultRoot, fileId, extractWikiLinks(content));
  storePropertiesForFile(fileId, content);
  return { created: existing === null };
}

/**
 * Single-file reindex by absolute path. Resolves vault root from caller context.
 */
export async function reindexFile(vaultRoot: string, absFilePath: string): Promise<void> {
  const exists = await fs
    .stat(absFilePath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    const relPath = toRelPath(vaultRoot, absFilePath);
    deleteFileByRelPath(vaultRoot, relPath);
    reresolveVaultLinks(vaultRoot);
    return;
  }
  const result = await indexFile(vaultRoot, absFilePath);
  // A new file may satisfy previously unresolved links (or re-home links whose
  // target was deleted, e.g. the second half of a rename).
  if (result.created) reresolveVaultLinks(vaultRoot);
}

export async function removeFileFromIndex(vaultRoot: string, absFilePath: string): Promise<void> {
  const relPath = toRelPath(vaultRoot, absFilePath);
  deleteFileByRelPath(vaultRoot, relPath);
  reresolveVaultLinks(vaultRoot);
}

export interface IndexRebuildResult {
  scanned: number;
  removed: number;
  durationMs: number;
}

export async function rebuildIndex(vaultRoot: string): Promise<IndexRebuildResult> {
  const start = Date.now();
  const absPaths = await walkMarkdown(vaultRoot);
  const seen = new Set<string>();

  for (const abs of absPaths) {
    const rel = toRelPath(vaultRoot, abs);
    seen.add(rel);
    try {
      await indexFile(vaultRoot, abs);
    } catch (err) {
      console.error('[indexer] failed to index', rel, err);
    }
  }

  // Remove rows that no longer exist on disk.
  const existing = listFileRelPaths(vaultRoot);
  let removed = 0;
  for (const rel of existing) {
    if (!seen.has(rel)) {
      deleteFileByRelPath(vaultRoot, rel);
      removed++;
    }
  }

  // Single re-resolution pass once the file set is final: files indexed early
  // in the walk could not resolve links to files indexed later.
  reresolveVaultLinks(vaultRoot);

  return {
    scanned: absPaths.length,
    removed,
    durationMs: Date.now() - start,
  };
}

export function getIndexStatus(vaultRoot: string): IndexStatus {
  const indexed = countFiles(vaultRoot);
  return {
    totalFiles: indexed,
    indexedFiles: indexed,
    totalChunks: countChunks(vaultRoot),
    lastIndexedAt: lastIndexedAt(vaultRoot),
  };
}

/**
 * Schedules a debounced single-file reindex. Multiple rapid file changes
 * coalesce into a single reindex per file.
 */
const DEBOUNCE_MS = 500;
const pendingReindex = new Map<string, NodeJS.Timeout>();

export function scheduleReindexFile(vaultRoot: string, absFilePath: string): void {
  const key = absFilePath;
  const existing = pendingReindex.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingReindex.delete(key);
    void reindexFile(vaultRoot, absFilePath).catch((err) => {
      console.error('[indexer] debounced reindex failed', absFilePath, err);
    });
  }, DEBOUNCE_MS);
  pendingReindex.set(key, t);
}

export function scheduleRemoveFromIndex(vaultRoot: string, absFilePath: string): void {
  const key = absFilePath;
  const existing = pendingReindex.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingReindex.delete(key);
    void removeFileFromIndex(vaultRoot, absFilePath).catch((err) => {
      console.error('[indexer] debounced remove failed', absFilePath, err);
    });
  }, DEBOUNCE_MS);
  pendingReindex.set(key, t);
}

export { fromRelPath, toRelPath };
