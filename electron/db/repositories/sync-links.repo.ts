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
  // ---- Pull/reconcile state (TER-23) — all optional; absent on push-only rows ----
  externalUpdatedAt?: string; // ISO 8601; remote `updatedAt` observed at last reconcile
  lastPulledAt?: string; // ISO 8601; when we last pulled this item's remote state
  lastPulledHash?: string; // hash of the remote content at the last pull (see reconcile.computeRemoteHash)
}

interface SyncLinkRow {
  id: number;
  spec_item_id: string;
  connection_id: string;
  external_id: string;
  external_url: string;
  last_pushed_hash: string;
  last_pushed_at: number; // epoch ms
  // Pull/reconcile state (TER-23); nullable — absent on push-only rows.
  external_updated_at: number | null; // epoch ms
  last_pulled_at: number | null; // epoch ms
  last_pulled_hash: string | null;
}

function rowToSyncLink(row: SyncLinkRow): SyncLink {
  const link: SyncLink = {
    specItemId: row.spec_item_id,
    connectionId: row.connection_id,
    externalId: row.external_id,
    externalUrl: row.external_url,
    lastPushedHash: row.last_pushed_hash,
    lastPushedAt: new Date(row.last_pushed_at).toISOString(),
  };
  // Pull state is optional: only surface a field when its column is populated,
  // converting epoch-ms back to ISO. A push-only row leaves these keys absent.
  if (row.external_updated_at !== null) {
    link.externalUpdatedAt = new Date(row.external_updated_at).toISOString();
  }
  if (row.last_pulled_at !== null) {
    link.lastPulledAt = new Date(row.last_pulled_at).toISOString();
  }
  if (row.last_pulled_hash !== null) {
    link.lastPulledHash = row.last_pulled_hash;
  }
  return link;
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
 * duplicating. `lastPushedAt` is accepted as an ISO string and stored as epoch
 * ms; throws if it is not a valid date so a bad input fails with a clear message
 * rather than a downstream NOT NULL constraint error.
 */
export function upsertSyncLink(input: SyncLink): SyncLink {
  const lastPushedAt = new Date(input.lastPushedAt).getTime();
  if (Number.isNaN(lastPushedAt)) {
    throw new Error(
      `upsertSyncLink: invalid lastPushedAt (expected an ISO-8601 date): ${input.lastPushedAt}`,
    );
  }
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

/**
 * Record the pull/reconcile state for an existing link after a successful pull
 * (TER-23) — the pull-side counterpart to {@link upsertSyncLink}.
 *
 * It writes ONLY the three pull columns (`external_updated_at`, `last_pulled_at`,
 * `last_pulled_hash`) and leaves the push columns untouched; `upsertSyncLink`
 * likewise never writes the pull columns. Keeping the two writers deliberately
 * separate means a push can never clobber pull baseline state and a pull can
 * never clobber the last-pushed hash/timestamp — each direction owns its own
 * columns.
 *
 * This is a pure UPDATE keyed by (specItemId, connectionId, externalId): pull only ever runs
 * for an already-pushed item, so there is nothing to insert. Including `external_id` in the
 * key means a link that was re-pointed to a different remote between planning and applying is
 * left untouched (the UPDATE matches zero rows) rather than stamped with a stale remote's
 * baseline. A missing row is a
 * silent no-op (the UPDATE matches zero rows) rather than an error — e.g. the
 * link was deleted between planning and applying. `externalUpdatedAt` and
 * `lastPulledAt` are accepted as ISO strings and stored as epoch ms; each is
 * validated with the same `Number.isNaN` guard as `upsertSyncLink` so a bad input
 * fails with a clear message rather than a confusing downstream error.
 */
export function updateSyncLinkPullState(input: {
  specItemId: string;
  connectionId: string;
  externalId: string;
  externalUpdatedAt: string;
  lastPulledAt: string;
  lastPulledHash: string;
}): void {
  const externalUpdatedAt = new Date(input.externalUpdatedAt).getTime();
  if (Number.isNaN(externalUpdatedAt)) {
    throw new Error(
      `updateSyncLinkPullState: invalid externalUpdatedAt (expected an ISO-8601 date): ${input.externalUpdatedAt}`,
    );
  }
  const lastPulledAt = new Date(input.lastPulledAt).getTime();
  if (Number.isNaN(lastPulledAt)) {
    throw new Error(
      `updateSyncLinkPullState: invalid lastPulledAt (expected an ISO-8601 date): ${input.lastPulledAt}`,
    );
  }
  getDb()
    .prepare(
      `UPDATE sync_links SET
         external_updated_at = ?,
         last_pulled_at      = ?,
         last_pulled_hash    = ?
       WHERE spec_item_id = ? AND connection_id = ? AND external_id = ?`,
    )
    .run(
      externalUpdatedAt,
      lastPulledAt,
      input.lastPulledHash,
      input.specItemId,
      input.connectionId,
      input.externalId,
    );
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
