import { DatabaseSync } from 'node:sqlite';
import { app } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { MIGRATIONS } from './migrations';

let dbInstance: DatabaseSync | null = null;
let ftsAvailable = false;

/**
 * Opens (or returns existing) DB at userData/specforge.db.
 * Applies PRAGMAs and migrations on first open.
 *
 * The DB lives outside the vault deliberately — the vault stays portable
 * markdown only.
 */
export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;

  const userData = app.getPath('userData');
  if (!fs.existsSync(userData)) {
    fs.mkdirSync(userData, { recursive: true });
  }
  const dbPath = path.join(userData, 'specforge.db');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');

  runMigrations(db);

  dbInstance = db;
  return db;
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT id FROM _migrations').all() as Array<{ id: number }>;
  const applied = new Set(appliedRows.map((r) => r.id));

  const insertMigration = db.prepare(
    'INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    try {
      db.exec('BEGIN');
      db.exec(migration.sql);
      insertMigration.run(migration.id, migration.name, Date.now());
      db.exec('COMMIT');

      if (migration.name === 'fts5_chunks') {
        ftsAvailable = true;
      }
    } catch (err) {
      db.exec('ROLLBACK');
      // FTS5 may not be compiled into some sqlite builds; fall back gracefully.
      if (migration.name === 'fts5_chunks') {
        console.warn('[db] FTS5 unavailable, falling back to LIKE search:', err);
        // Record as applied so we don't retry on every boot.
        insertMigration.run(migration.id, migration.name + '_skipped', Date.now());
        ftsAvailable = false;
        continue;
      }
      throw err;
    }
  }

  // Probe for FTS5 if not just installed (e.g. existing DB).
  if (!ftsAvailable) {
    try {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='markdown_chunks_fts'`)
        .get();
      ftsAvailable = row !== undefined;
    } catch {
      ftsAvailable = false;
    }
  }
}

export function isFtsAvailable(): boolean {
  return ftsAvailable;
}

/**
 * Runs `fn` inside a manual transaction, committing on success and rolling
 * back on any thrown error. Replaces better-sqlite3's `db.transaction()`.
 */
export function transaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (err) {
      console.error('[db] close failed', err);
    }
    dbInstance = null;
  }
}
