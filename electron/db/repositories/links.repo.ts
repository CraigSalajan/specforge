import { getDb, transaction } from '../index';

export interface LinkInsert {
  targetRaw: string;
  targetRelPath: string | null;
  line: number;
}

/** Delete-then-insert all wikilink rows for a file (same pattern as chunks). */
export function replaceLinksForFile(fileId: number, links: LinkInsert[]): void {
  const db = getDb();
  const del = db.prepare('DELETE FROM links WHERE file_id = ?');
  const ins = db.prepare(
    `INSERT INTO links (file_id, target_raw, target_rel_path, line, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  transaction(() => {
    del.run(fileId);
    for (const link of links) {
      ins.run(fileId, link.targetRaw, link.targetRelPath, link.line, now);
    }
  });
}

export interface BacklinkRow {
  sourceRelPath: string;
  line: number;
  targetRaw: string;
}

/** Files linking TO `relPath` (resolved target match, case-insensitive). */
export function listBacklinks(vaultPath: string, relPath: string): BacklinkRow[] {
  const rows = getDb()
    .prepare(
      `SELECT f.rel_path AS rel_path, l.line AS line, l.target_raw AS target_raw
       FROM links l
       JOIN files f ON f.id = l.file_id
       WHERE f.vault_path = ?
         AND l.target_rel_path IS NOT NULL
         AND lower(l.target_rel_path) = lower(?)
       ORDER BY f.rel_path ASC, l.line ASC`,
    )
    .all(vaultPath, relPath) as Array<{ rel_path: string; line: number; target_raw: string }>;
  return rows.map((r) => ({
    sourceRelPath: r.rel_path,
    line: r.line,
    targetRaw: r.target_raw,
  }));
}

export interface OutgoingLinkRow {
  targetRaw: string;
  targetRelPath: string | null;
  line: number;
}

/** All wikilinks FROM `relPath`, resolved or not, in document order. */
export function listOutgoingLinks(vaultPath: string, relPath: string): OutgoingLinkRow[] {
  const rows = getDb()
    .prepare(
      `SELECT l.target_raw AS target_raw, l.target_rel_path AS target_rel_path, l.line AS line
       FROM links l
       JOIN files f ON f.id = l.file_id
       WHERE f.vault_path = ? AND f.rel_path = ?
       ORDER BY l.line ASC, l.id ASC`,
    )
    .all(vaultPath, relPath) as Array<{
      target_raw: string;
      target_rel_path: string | null;
      line: number;
    }>;
  return rows.map((r) => ({
    targetRaw: r.target_raw,
    targetRelPath: r.target_rel_path,
    line: r.line,
  }));
}

export interface StaleLink {
  id: number;
  targetRaw: string;
}

/**
 * Links whose resolution may be outdated: never resolved (NULL target) or
 * resolved to a rel_path that no longer exists in the vault's files table.
 */
export function listStaleLinks(vaultPath: string): StaleLink[] {
  const rows = getDb()
    .prepare(
      `SELECT l.id AS id, l.target_raw AS target_raw
       FROM links l
       JOIN files f ON f.id = l.file_id
       WHERE f.vault_path = ?
         AND (l.target_rel_path IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM files t
                WHERE t.vault_path = f.vault_path
                  AND lower(t.rel_path) = lower(l.target_rel_path)
              ))`,
    )
    .all(vaultPath) as Array<{ id: number; target_raw: string }>;
  return rows.map((r) => ({ id: r.id, targetRaw: r.target_raw }));
}

export function setLinkTarget(linkId: number, targetRelPath: string | null): void {
  getDb()
    .prepare('UPDATE links SET target_rel_path = ? WHERE id = ?')
    .run(targetRelPath, linkId);
}
