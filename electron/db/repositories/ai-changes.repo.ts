import { getDb } from '../index';

export type AiChangeType = 'create' | 'edit' | 'rename' | 'delete';

export interface AiFileChangeRow {
  id: number;
  session_id: number | null;
  vault_path: string;
  rel_path: string;
  new_rel_path: string | null;
  change_type: AiChangeType;
  before_content: string | null;
  after_content: string | null;
  applied: number;
  created_at: number;
}

export interface AiFileChange {
  id: number;
  sessionId: number | null;
  vaultPath: string;
  relPath: string;
  newRelPath: string | null;
  changeType: AiChangeType;
  beforeContent: string | null;
  afterContent: string | null;
  applied: boolean;
  createdAt: number;
}

function rowToChange(r: AiFileChangeRow): AiFileChange {
  return {
    id: r.id,
    sessionId: r.session_id,
    vaultPath: r.vault_path,
    relPath: r.rel_path,
    newRelPath: r.new_rel_path,
    changeType: r.change_type,
    beforeContent: r.before_content,
    afterContent: r.after_content,
    applied: r.applied !== 0,
    createdAt: r.created_at,
  };
}

export interface RecordChangeInput {
  sessionId: number | null;
  vaultPath: string;
  relPath: string;
  newRelPath?: string | null;
  changeType: AiChangeType;
  beforeContent: string | null;
  afterContent: string | null;
  applied: boolean;
}

export function recordChange(input: RecordChangeInput): AiFileChange {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `INSERT INTO ai_file_changes
         (session_id, vault_path, rel_path, new_rel_path, change_type,
          before_content, after_content, applied, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      input.vaultPath,
      input.relPath,
      input.newRelPath ?? null,
      input.changeType,
      input.beforeContent,
      input.afterContent,
      input.applied ? 1 : 0,
      now,
    );
  return {
    id: Number(res.lastInsertRowid),
    sessionId: input.sessionId,
    vaultPath: input.vaultPath,
    relPath: input.relPath,
    newRelPath: input.newRelPath ?? null,
    changeType: input.changeType,
    beforeContent: input.beforeContent,
    afterContent: input.afterContent,
    applied: input.applied,
    createdAt: now,
  };
}

export function markApplied(id: number, applied: boolean): void {
  getDb()
    .prepare('UPDATE ai_file_changes SET applied = ? WHERE id = ?')
    .run(applied ? 1 : 0, id);
}

export function listChanges(vaultPath: string, limit: number): AiFileChange[] {
  const rows = getDb()
    .prepare(
      `SELECT id, session_id, vault_path, rel_path, new_rel_path, change_type,
              before_content, after_content, applied, created_at
         FROM ai_file_changes
        WHERE vault_path = ?
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(vaultPath, Math.max(1, Math.min(limit, 500))) as unknown as AiFileChangeRow[];
  return rows.map(rowToChange);
}

export function latestApplied(vaultPath: string): AiFileChange | null {
  const row = getDb()
    .prepare(
      `SELECT id, session_id, vault_path, rel_path, new_rel_path, change_type,
              before_content, after_content, applied, created_at
         FROM ai_file_changes
        WHERE vault_path = ? AND applied = 1
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get(vaultPath) as AiFileChangeRow | undefined;
  return row ? rowToChange(row) : null;
}
