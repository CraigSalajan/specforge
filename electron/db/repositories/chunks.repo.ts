import { getDb, isFtsAvailable, transaction } from '../index';
import type { Chunk } from '../../indexing/chunker';

export interface ChunkRow {
  id: number;
  file_id: number;
  heading_path: string;
  level: number;
  content: string;
  start_line: number;
  end_line: number;
  ord: number;
}

export function replaceChunksForFile(fileId: number, chunks: Chunk[]): void {
  const db = getDb();
  const del = db.prepare('DELETE FROM markdown_chunks WHERE file_id = ?');
  const ins = db.prepare(
    `INSERT INTO markdown_chunks
       (file_id, heading_path, level, content, start_line, end_line, ord)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  transaction(() => {
    del.run(fileId);
    let ord = 0;
    for (const c of chunks) {
      ins.run(fileId, c.headingPath, c.level, c.content, c.startLine, c.endLine, ord++);
    }
  });
}

export function countChunks(vaultPath: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM markdown_chunks
       JOIN files ON files.id = markdown_chunks.file_id
       WHERE files.vault_path = ?`,
    )
    .get(vaultPath) as { c: number };
  return row.c;
}

export interface SearchHit {
  relPath: string;
  headingPath: string;
  excerpt: string;
  score: number;
  /** 1-based first line of the matched chunk (its heading line). */
  startLine: number;
}

export interface SearchFilter {
  folders?: string[];
  files?: string[];
}

/**
 * Builds an optional path-scoping clause for `files.rel_path`. Folders match
 * any descendant (`prefix/%`), files match exactly via an `IN (...)` set.
 * Folder/file conditions are OR'd together; the caller AND's the returned
 * clause with the rest of the WHERE. Returns null when no narrowing applies.
 */
function buildPathFilter(filter?: SearchFilter): { clause: string; params: string[] } | null {
  if (!filter) return null;
  const folders = (filter.folders ?? []).filter((f) => f.length > 0);
  const files = (filter.files ?? []).filter((f) => f.length > 0);
  if (folders.length === 0 && files.length === 0) return null;

  const conditions: string[] = [];
  const params: string[] = [];

  if (files.length > 0) {
    const placeholders = files.map(() => '?').join(', ');
    conditions.push(`f.rel_path IN (${placeholders})`);
    params.push(...files);
  }

  for (const folder of folders) {
    // Escape LIKE metacharacters, then match the folder itself or any descendant.
    const escaped = folder.replace(/[%_\\]/g, (m) => '\\' + m);
    conditions.push(`f.rel_path = ?`);
    params.push(folder);
    conditions.push(`f.rel_path LIKE ? ESCAPE '\\'`);
    params.push(escaped + '/%');
  }

  return { clause: '(' + conditions.join(' OR ') + ')', params };
}

const EXCERPT_MAX = 240;

function buildExcerpt(content: string, query: string): string {
  const lower = content.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) {
    return content.length > EXCERPT_MAX ? content.slice(0, EXCERPT_MAX) + '…' : content;
  }
  const start = Math.max(0, idx - 60);
  const end = Math.min(content.length, idx + query.length + 180);
  let slice = content.slice(start, end);
  if (start > 0) slice = '…' + slice;
  if (end < content.length) slice = slice + '…';
  return slice;
}

export function searchChunks(
  vaultPath: string,
  query: string,
  limit: number,
  filter?: SearchFilter,
): SearchHit[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const lim = Math.max(1, Math.min(limit, 100));

  if (isFtsAvailable()) {
    return searchChunksFts(vaultPath, trimmed, lim, filter);
  }
  return searchChunksLike(vaultPath, trimmed, lim, filter);
}

function ftsEscape(q: string): string {
  // Wrap each token in double quotes to neutralize special FTS5 syntax
  // (NEAR, AND, OR, *, etc.) while still allowing multi-token matches.
  return q
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

function searchChunksFts(
  vaultPath: string,
  query: string,
  limit: number,
  filter?: SearchFilter,
): SearchHit[] {
  const ftsQuery = ftsEscape(query);
  if (ftsQuery.length === 0) return [];
  const pathFilter = buildPathFilter(filter);
  const filterClause = pathFilter ? ` AND ${pathFilter.clause}` : '';
  const rows = getDb()
    .prepare(
      `SELECT f.rel_path AS rel_path,
              markdown_chunks.heading_path AS heading_path,
              markdown_chunks.content AS content,
              markdown_chunks.start_line AS start_line,
              bm25(markdown_chunks_fts) AS score
       FROM markdown_chunks_fts
       JOIN markdown_chunks ON markdown_chunks.id = markdown_chunks_fts.rowid
       JOIN files f ON f.id = markdown_chunks.file_id
       WHERE markdown_chunks_fts MATCH ?
         AND f.vault_path = ?${filterClause}
       ORDER BY score ASC
       LIMIT ?`,
    )
    .all(ftsQuery, vaultPath, ...(pathFilter?.params ?? []), limit) as Array<{
      rel_path: string;
      heading_path: string;
      content: string;
      start_line: number;
      score: number;
    }>;

  return rows.map((r) => ({
    relPath: r.rel_path,
    headingPath: r.heading_path,
    excerpt: buildExcerpt(r.content, query),
    // bm25 returns lower=better; invert for caller convenience.
    score: -r.score,
    startLine: r.start_line,
  }));
}

function searchChunksLike(
  vaultPath: string,
  query: string,
  limit: number,
  filter?: SearchFilter,
): SearchHit[] {
  const like = `%${query.replace(/[%_]/g, (m) => '\\' + m)}%`;
  const pathFilter = buildPathFilter(filter);
  const filterClause = pathFilter ? ` AND ${pathFilter.clause}` : '';
  const rows = getDb()
    .prepare(
      `SELECT f.rel_path AS rel_path,
              markdown_chunks.heading_path AS heading_path,
              markdown_chunks.content AS content,
              markdown_chunks.start_line AS start_line
       FROM markdown_chunks
       JOIN files f ON f.id = markdown_chunks.file_id
       WHERE f.vault_path = ?
         AND (markdown_chunks.content LIKE ? ESCAPE '\\'
              OR markdown_chunks.heading_path LIKE ? ESCAPE '\\')${filterClause}
       LIMIT ?`,
    )
    .all(vaultPath, like, like, ...(pathFilter?.params ?? []), limit) as Array<{
      rel_path: string;
      heading_path: string;
      content: string;
      start_line: number;
    }>;

  const qLower = query.toLowerCase();
  return rows
    .map((r) => {
      const occurrences = (r.content.toLowerCase().match(new RegExp(escapeRegex(qLower), 'g')) ?? [])
        .length;
      const headingHit = r.heading_path.toLowerCase().includes(qLower) ? 1 : 0;
      return {
        relPath: r.rel_path,
        headingPath: r.heading_path,
        excerpt: buildExcerpt(r.content, query),
        score: occurrences + headingHit * 2,
        startLine: r.start_line,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
