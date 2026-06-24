import { getDb } from '../index';

export interface ChatSessionRow {
  id: number;
  vault_path: string;
  title: string;
  mode: string;
  context_scope: string;
  created_at: number;
  updated_at: number;
}

export interface ChatMessageRow {
  id: number;
  session_id: number;
  role: string;
  content: string;
  reasoning: string | null;
  created_at: number;
}

export function listSessions(vaultPath: string): ChatSessionRow[] {
  return getDb()
    .prepare(
      `SELECT id, vault_path, title, mode, context_scope, created_at, updated_at
         FROM chat_sessions
        WHERE vault_path = ?
        ORDER BY updated_at DESC`,
    )
    .all(vaultPath) as unknown as ChatSessionRow[];
}

export function getSession(id: number): ChatSessionRow | null {
  const row = getDb()
    .prepare(
      `SELECT id, vault_path, title, mode, context_scope, created_at, updated_at
         FROM chat_sessions WHERE id = ?`,
    )
    .get(id) as ChatSessionRow | undefined;
  return row ?? null;
}

export function createSession(input: {
  vaultPath: string;
  title: string;
  mode: string;
  contextScope: string;
}): ChatSessionRow {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `INSERT INTO chat_sessions (vault_path, title, mode, context_scope, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.vaultPath, input.title, input.mode, input.contextScope, now, now);
  return {
    id: Number(res.lastInsertRowid),
    vault_path: input.vaultPath,
    title: input.title,
    mode: input.mode,
    context_scope: input.contextScope,
    created_at: now,
    updated_at: now,
  };
}

export function updateScope(sessionId: number, contextScopeJson: string): void {
  getDb()
    .prepare('UPDATE chat_sessions SET context_scope = ?, updated_at = ? WHERE id = ?')
    .run(contextScopeJson, Date.now(), sessionId);
}

export function renameSession(id: number, title: string): void {
  getDb()
    .prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, Date.now(), id);
}

export function deleteSession(id: number): void {
  getDb().prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
}

export function getMessages(sessionId: number): ChatMessageRow[] {
  return getDb()
    .prepare(
      `SELECT id, session_id, role, content, reasoning, created_at
         FROM chat_messages
        WHERE session_id = ?
        ORDER BY id ASC`,
    )
    .all(sessionId) as unknown as ChatMessageRow[];
}

export function appendMessage(input: {
  sessionId: number;
  role: string;
  content: string;
  reasoning?: string | null;
}): ChatMessageRow {
  const db = getDb();
  const now = Date.now();
  const reasoning = input.reasoning ?? null;
  const res = db
    .prepare(
      `INSERT INTO chat_messages (session_id, role, content, reasoning, created_at)
         VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.sessionId, input.role, input.content, reasoning, now);
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(
    now,
    input.sessionId,
  );
  return {
    id: Number(res.lastInsertRowid),
    session_id: input.sessionId,
    role: input.role,
    content: input.content,
    reasoning,
    created_at: now,
  };
}
