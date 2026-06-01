/**
 * SQLite migrations for SpecForge.
 *
 * Each migration is a raw SQL string applied in order. Applied migrations
 * are recorded in the `_migrations` bookkeeping table to make startup
 * idempotent.
 */

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    id: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS files (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        vault_path  TEXT NOT NULL,
        rel_path    TEXT NOT NULL,
        mtime       INTEGER NOT NULL,
        size        INTEGER NOT NULL,
        hash        TEXT NOT NULL,
        indexed_at  INTEGER NOT NULL,
        UNIQUE (vault_path, rel_path)
      );

      CREATE INDEX IF NOT EXISTS idx_files_vault_path ON files(vault_path);

      CREATE TABLE IF NOT EXISTS markdown_chunks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id       INTEGER NOT NULL,
        heading_path  TEXT NOT NULL,
        level         INTEGER NOT NULL,
        content       TEXT NOT NULL,
        start_line    INTEGER NOT NULL,
        end_line      INTEGER NOT NULL,
        ord           INTEGER NOT NULL,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON markdown_chunks(file_id);

      CREATE TABLE IF NOT EXISTS embeddings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id    INTEGER NOT NULL UNIQUE,
        model       TEXT NOT NULL,
        vector      BLOB NOT NULL,
        dim         INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        FOREIGN KEY (chunk_id) REFERENCES markdown_chunks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        vault_path  TEXT NOT NULL,
        title       TEXT NOT NULL,
        mode        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_vault_path ON chat_sessions(vault_path);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  INTEGER NOT NULL,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);

      CREATE TABLE IF NOT EXISTS ai_file_changes (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      INTEGER,
        rel_path        TEXT NOT NULL,
        change_type     TEXT NOT NULL CHECK (change_type IN ('create','edit','rename','delete')),
        before_content  TEXT,
        after_content   TEXT,
        applied         INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ai_file_changes_session_id ON ai_file_changes(session_id);

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: 'fts5_chunks',
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS markdown_chunks_fts USING fts5(
        content,
        heading_path,
        content='markdown_chunks',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS markdown_chunks_ai AFTER INSERT ON markdown_chunks BEGIN
        INSERT INTO markdown_chunks_fts(rowid, content, heading_path)
        VALUES (new.id, new.content, new.heading_path);
      END;

      CREATE TRIGGER IF NOT EXISTS markdown_chunks_ad AFTER DELETE ON markdown_chunks BEGIN
        INSERT INTO markdown_chunks_fts(markdown_chunks_fts, rowid, content, heading_path)
        VALUES ('delete', old.id, old.content, old.heading_path);
      END;

      CREATE TRIGGER IF NOT EXISTS markdown_chunks_au AFTER UPDATE ON markdown_chunks BEGIN
        INSERT INTO markdown_chunks_fts(markdown_chunks_fts, rowid, content, heading_path)
        VALUES ('delete', old.id, old.content, old.heading_path);
        INSERT INTO markdown_chunks_fts(rowid, content, heading_path)
        VALUES (new.id, new.content, new.heading_path);
      END;
    `,
  },
  {
    id: 3,
    name: 'ai_changes_vault_columns',
    sql: `
      ALTER TABLE ai_file_changes ADD COLUMN vault_path TEXT NOT NULL DEFAULT '';
      ALTER TABLE ai_file_changes ADD COLUMN new_rel_path TEXT;
      CREATE INDEX IF NOT EXISTS idx_ai_file_changes_vault_path ON ai_file_changes(vault_path);
    `,
  },
  {
    id: 4,
    name: 'embeddings_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);
    `,
  },
  {
    id: 5,
    name: 'chat_sessions_context_scope',
    sql: `
      ALTER TABLE chat_sessions ADD COLUMN context_scope TEXT NOT NULL DEFAULT '{}';
    `,
  },
];
