import { getDb, transaction } from '../index';

export interface PropertyInsert {
  key: string;
  value: string;
  idx: number;
}

/** Delete-then-insert all frontmatter property rows for a file (same pattern as links). */
export function replacePropertiesForFile(fileId: number, props: PropertyInsert[]): void {
  const db = getDb();
  const del = db.prepare('DELETE FROM doc_properties WHERE file_id = ?');
  const ins = db.prepare(
    `INSERT INTO doc_properties (file_id, key, value, idx)
     VALUES (?, ?, ?, ?)`,
  );
  transaction(() => {
    del.run(fileId);
    for (const prop of props) {
      ins.run(fileId, prop.key, prop.value, prop.idx);
    }
  });
}

/** Files in `vaultPath` whose frontmatter has `key` set to `value` (both case-insensitive). */
export function queryFilesByProperty(
  vaultPath: string,
  key: string,
  value: string,
): { relPath: string }[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT f.rel_path AS rel_path
       FROM doc_properties p
       JOIN files f ON f.id = p.file_id
       WHERE f.vault_path = ?
         AND lower(p.key) = lower(?)
         AND lower(p.value) = lower(?)
       ORDER BY f.rel_path ASC`,
    )
    .all(vaultPath, key, value) as Array<{ rel_path: string }>;
  return rows.map((r) => ({ relPath: r.rel_path }));
}

/** Distinct frontmatter keys used across the vault, ordered case-insensitively. */
export function listKeys(vaultPath: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT p.key AS key
       FROM doc_properties p
       JOIN files f ON f.id = p.file_id
       WHERE f.vault_path = ?
       ORDER BY lower(p.key) ASC`,
    )
    .all(vaultPath) as Array<{ key: string }>;
  return rows.map((r) => r.key);
}

/** Distinct non-null values recorded for `key` across the vault, ordered case-insensitively. */
export function listValues(vaultPath: string, key: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT p.value AS value
       FROM doc_properties p
       JOIN files f ON f.id = p.file_id
       WHERE f.vault_path = ?
         AND lower(p.key) = lower(?)
         AND p.value IS NOT NULL
       ORDER BY lower(p.value) ASC`,
    )
    .all(vaultPath, key) as Array<{ value: string }>;
  return rows.map((r) => r.value);
}
