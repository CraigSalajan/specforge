import { getDb } from '../index';

/**
 * A SyncLink ties a SpecForge item to its external counterpart in a PM tool
 * (Jira / ADO / Linear), enabling idempotent, duplicate-free pushes. Keyed by
 * (specItemId, connectionId): the same item may push to more than one target.
 */
export interface SyncLink {
  specItemId: string; // SpecForge item (epic/feature/story)
  connectionId: string; // configured account+project target
  externalId: string; // Jira key / ADO ID / Linear ID
  externalUrl: string; // deep link
  lastPushedHash: string; // content hash at last push (see util/hash.sha256)
  lastPushedAt: string; // ISO 8601 timestamp
}

interface SyncLinkRow {
  id: number;
  spec_item_id: string;
  connection_id: string;
  external_id: string;
  external_url: string;
  last_pushed_hash: string;
  last_pushed_at: number; // epoch ms
}

function rowToSyncLink(row: SyncLinkRow): SyncLink {
  return {
    specItemId: row.spec_item_id,
    connectionId: row.connection_id,
    externalId: row.external_id,
    externalUrl: row.external_url,
    lastPushedHash: row.last_pushed_hash,
    lastPushedAt: new Date(row.last_pushed_at).toISOString(),
  };
}

export function findSyncLink(specItemId: string, connectionId: string): SyncLink | null {
  const row = getDb()
    .prepare('SELECT * FROM sync_links WHERE spec_item_id = ? AND connection_id = ?')
    .get(specItemId, connectionId) as SyncLinkRow | undefined;
  return row ? rowToSyncLink(row) : null;
}

/**
 * Insert or update the link for (specItemId, connectionId). Idempotent: a second
 * push for the same item+connection updates the existing row rather than
 * duplicating. `lastPushedAt` is accepted as an ISO string and stored as epoch ms.
 */
export function upsertSyncLink(input: SyncLink): SyncLink {
  const lastPushedAt = new Date(input.lastPushedAt).getTime();
  getDb()
    .prepare(
      `INSERT INTO sync_links
         (spec_item_id, connection_id, external_id, external_url, last_pushed_hash, last_pushed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(spec_item_id, connection_id) DO UPDATE SET
         external_id      = excluded.external_id,
         external_url     = excluded.external_url,
         last_pushed_hash = excluded.last_pushed_hash,
         last_pushed_at   = excluded.last_pushed_at`,
    )
    .run(
      input.specItemId,
      input.connectionId,
      input.externalId,
      input.externalUrl,
      input.lastPushedHash,
      lastPushedAt,
    );
  const saved = findSyncLink(input.specItemId, input.connectionId);
  if (!saved) throw new Error('upsertSyncLink: row not found immediately after upsert');
  return saved;
}

export function listSyncLinksForItem(specItemId: string): SyncLink[] {
  const rows = getDb()
    .prepare('SELECT * FROM sync_links WHERE spec_item_id = ? ORDER BY connection_id')
    .all(specItemId) as unknown as SyncLinkRow[];
  return rows.map(rowToSyncLink);
}

export function listSyncLinksForConnection(connectionId: string): SyncLink[] {
  const rows = getDb()
    .prepare('SELECT * FROM sync_links WHERE connection_id = ? ORDER BY spec_item_id')
    .all(connectionId) as unknown as SyncLinkRow[];
  return rows.map(rowToSyncLink);
}

export function deleteSyncLink(specItemId: string, connectionId: string): void {
  getDb()
    .prepare('DELETE FROM sync_links WHERE spec_item_id = ? AND connection_id = ?')
    .run(specItemId, connectionId);
}
