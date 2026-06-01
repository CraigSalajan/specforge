import { getDb, transaction } from '../index';

/**
 * Phase 3: vector storage and similarity search.
 *
 * Vectors are stored as raw little-endian Float32 BLOBs in the `embeddings`
 * table. Cosine similarity is computed in JS over the candidate set, which is
 * acceptable for the local-vault scale (thousands of chunks).
 */

export interface EmbeddingRow {
  id: number;
  chunk_id: number;
  model: string;
  vector: Buffer;
  dim: number;
  created_at: number;
}

export interface ChunkRefRow {
  chunk_id: number;
  rel_path: string;
  heading_path: string;
  content: string;
}

function vectorToBuffer(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i], i * 4);
  }
  return buf;
}

function bufferToVector(buf: Uint8Array, dim: number): number[] {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    out[i] = b.readFloatLE(i * 4);
  }
  return out;
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  if (aMag === 0 || bMag === 0) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

export interface UpsertItem {
  chunkId: number;
  model: string;
  vector: number[];
  dim: number;
}

export function upsertEmbeddings(items: UpsertItem[]): number {
  if (items.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO embeddings (chunk_id, model, vector, dim, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET
         model = excluded.model,
         vector = excluded.vector,
         dim = excluded.dim,
         created_at = excluded.created_at`,
  );
  return transaction(() => {
    let n = 0;
    const now = Date.now();
    for (const item of items) {
      if (item.vector.length !== item.dim) {
        throw new Error(
          `Embedding dim mismatch: vector.length=${item.vector.length}, dim=${item.dim}`,
        );
      }
      stmt.run(item.chunkId, item.model, vectorToBuffer(item.vector), item.dim, now);
      n++;
    }
    return n;
  });
}

export function clearEmbeddings(vaultPath: string, model?: string): number {
  const db = getDb();
  if (model) {
    const res = db
      .prepare(
        `DELETE FROM embeddings
           WHERE model = ?
             AND chunk_id IN (
               SELECT mc.id FROM markdown_chunks mc
               JOIN files f ON f.id = mc.file_id
               WHERE f.vault_path = ?
             )`,
      )
      .run(model, vaultPath);
    return Number(res.changes);
  }
  const res = db
    .prepare(
      `DELETE FROM embeddings
         WHERE chunk_id IN (
           SELECT mc.id FROM markdown_chunks mc
           JOIN files f ON f.id = mc.file_id
           WHERE f.vault_path = ?
         )`,
    )
    .run(vaultPath);
  return Number(res.changes);
}

export interface PendingChunkRef {
  chunkId: number;
  relPath: string;
  headingPath: string;
  content: string;
}

/**
 * Lists chunks for the given vault that do not yet have an embedding for
 * the requested model. Used to drive incremental embedding rebuilds.
 */
export function listPendingChunks(
  vaultPath: string,
  model: string,
  limit: number,
): PendingChunkRef[] {
  const rows = getDb()
    .prepare(
      `SELECT mc.id AS chunk_id,
              f.rel_path AS rel_path,
              mc.heading_path AS heading_path,
              mc.content AS content
         FROM markdown_chunks mc
         JOIN files f ON f.id = mc.file_id
        WHERE f.vault_path = ?
          AND NOT EXISTS (
            SELECT 1 FROM embeddings e
             WHERE e.chunk_id = mc.id
               AND e.model = ?
          )
        ORDER BY mc.id ASC
        LIMIT ?`,
    )
    .all(vaultPath, model, limit) as Array<{
      chunk_id: number;
      rel_path: string;
      heading_path: string;
      content: string;
    }>;
  return rows.map((r) => ({
    chunkId: r.chunk_id,
    relPath: r.rel_path,
    headingPath: r.heading_path,
    content: r.content,
  }));
}

export interface SimilaritySearchHit {
  relPath: string;
  headingPath: string;
  excerpt: string;
  score: number;
}

export interface SearchFilter {
  folders?: string[];
  files?: string[];
}

/**
 * Builds an optional path-scoping clause for `f.rel_path`. Folders match the
 * folder itself or any descendant (`prefix/%`); files match exactly via an
 * `IN (...)` set. Conditions are OR'd; the caller AND's the clause with the
 * rest of the WHERE. Returns null when nothing narrows the search.
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
    const escaped = folder.replace(/[%_\\]/g, (m) => '\\' + m);
    conditions.push(`f.rel_path = ?`);
    params.push(folder);
    conditions.push(`f.rel_path LIKE ? ESCAPE '\\'`);
    params.push(escaped + '/%');
  }

  return { clause: '(' + conditions.join(' OR ') + ')', params };
}

const EXCERPT_MAX = 240;

function buildExcerpt(content: string): string {
  if (content.length <= EXCERPT_MAX) return content;
  return content.slice(0, EXCERPT_MAX) + '…';
}

/**
 * Loads all embeddings for the vault matching the given model and computes
 * cosine similarity in JS. The local-vault scale (tens to low thousands of
 * chunks) makes the naive approach acceptable.
 */
export function searchByVector(
  vaultPath: string,
  vector: number[],
  model: string,
  limit: number,
  filter?: SearchFilter,
): SimilaritySearchHit[] {
  const pathFilter = buildPathFilter(filter);
  const filterClause = pathFilter ? `\n          AND ${pathFilter.clause}` : '';
  const rows = getDb()
    .prepare(
      `SELECT mc.id AS chunk_id,
              f.rel_path AS rel_path,
              mc.heading_path AS heading_path,
              mc.content AS content,
              e.vector AS vector,
              e.dim AS dim
         FROM embeddings e
         JOIN markdown_chunks mc ON mc.id = e.chunk_id
         JOIN files f ON f.id = mc.file_id
        WHERE f.vault_path = ?
          AND e.model = ?
          AND e.dim = ?${filterClause}`,
    )
    .all(vaultPath, model, vector.length, ...(pathFilter?.params ?? [])) as Array<{
      chunk_id: number;
      rel_path: string;
      heading_path: string;
      content: string;
      vector: Uint8Array;
      dim: number;
    }>;

  const scored: SimilaritySearchHit[] = rows.map((r) => {
    const vec = bufferToVector(r.vector, r.dim);
    const score = cosineSim(vec, vector);
    return {
      relPath: r.rel_path,
      headingPath: r.heading_path,
      excerpt: buildExcerpt(r.content),
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit));
}
