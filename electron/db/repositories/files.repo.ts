import { getDb } from '../index';

export interface FileRow {
  id: number;
  vault_path: string;
  rel_path: string;
  mtime: number;
  size: number;
  hash: string;
  indexed_at: number;
}

export function findFileByRelPath(vaultPath: string, relPath: string): FileRow | null {
  const row = getDb()
    .prepare('SELECT * FROM files WHERE vault_path = ? AND rel_path = ?')
    .get(vaultPath, relPath) as FileRow | undefined;
  return row ?? null;
}

export function upsertFile(input: Omit<FileRow, 'id'>): number {
  const db = getDb();
  const existing = findFileByRelPath(input.vault_path, input.rel_path);
  if (existing) {
    db.prepare(
      `UPDATE files SET mtime = ?, size = ?, hash = ?, indexed_at = ?
       WHERE id = ?`,
    ).run(input.mtime, input.size, input.hash, input.indexed_at, existing.id);
    return existing.id;
  }
  const result = db
    .prepare(
      `INSERT INTO files (vault_path, rel_path, mtime, size, hash, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.vault_path,
      input.rel_path,
      input.mtime,
      input.size,
      input.hash,
      input.indexed_at,
    );
  return Number(result.lastInsertRowid);
}

export function deleteFileByRelPath(vaultPath: string, relPath: string): void {
  getDb()
    .prepare('DELETE FROM files WHERE vault_path = ? AND rel_path = ?')
    .run(vaultPath, relPath);
}

export function listFileRelPaths(vaultPath: string): string[] {
  const rows = getDb()
    .prepare('SELECT rel_path FROM files WHERE vault_path = ?')
    .all(vaultPath) as Array<{ rel_path: string }>;
  return rows.map((r) => r.rel_path);
}

export function countFiles(vaultPath: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM files WHERE vault_path = ?')
    .get(vaultPath) as { c: number };
  return row.c;
}

export function lastIndexedAt(vaultPath: string): number | null {
  const row = getDb()
    .prepare('SELECT MAX(indexed_at) AS m FROM files WHERE vault_path = ?')
    .get(vaultPath) as { m: number | null };
  return row.m ?? null;
}
