import { ipcMain } from 'electron';
import * as path from 'node:path';
import {
  appendMessage,
  createSession,
  deleteSession,
  getMessages,
  getSession,
  listSessions,
  renameSession,
  updateScope,
  type ChatMessageRow,
  type ChatSessionRow,
} from '../db/repositories/chats.repo';

const Channels = {
  ListSessions: 'specforge:chats-list-sessions',
  CreateSession: 'specforge:chats-create-session',
  GetMessages: 'specforge:chats-get-messages',
  AppendMessage: 'specforge:chats-append-message',
  RenameSession: 'specforge:chats-rename-session',
  DeleteSession: 'specforge:chats-delete-session',
  SetScope: 'specforge:chats-set-scope',
} as const;

interface ContextScope {
  wholeVault: boolean;
  folders: string[];
  files: string[];
  includeActiveFile: boolean;
}

const EMPTY_CONTEXT_SCOPE: ContextScope = {
  wholeVault: false,
  folders: [],
  files: [],
  includeActiveFile: true,
};

const MAX_SCOPE_ENTRIES = 200;

/** Forward-slash normalize, strip leading/trailing slashes, reject `..`/`.`. */
function canonicalRelPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const normalized = input.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return null;
  }
  return segments.join('/');
}

function sanitizePathArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= MAX_SCOPE_ENTRIES) break;
    const canon = canonicalRelPath(entry);
    if (canon !== null) out.push(canon);
  }
  return out;
}

/** Validates and canonicalizes an incoming ContextScope payload. */
function validateScope(value: unknown): ContextScope {
  if (!value || typeof value !== 'object') return { ...EMPTY_CONTEXT_SCOPE };
  const v = value as Partial<ContextScope>;
  return {
    wholeVault: v.wholeVault === true,
    folders: sanitizePathArray(v.folders),
    files: sanitizePathArray(v.files),
    includeActiveFile: v.includeActiveFile !== false,
  };
}

/** Parses a stored context_scope JSON string into a normalized ContextScope. */
function parseScope(json: string): ContextScope {
  if (!json || json === '{}') return { ...EMPTY_CONTEXT_SCOPE };
  try {
    return validateScope(JSON.parse(json));
  } catch {
    return { ...EMPTY_CONTEXT_SCOPE };
  }
}

const ALLOWED_MODES = new Set(['general', 'answer-from-vault', 'draft', 'edit', 'review']);
const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);

function assertVaultPath(vaultPath: unknown): string {
  if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
    throw new Error('Invalid vault path');
  }
  return path.resolve(vaultPath);
}

function assertNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function assertString(value: unknown, label: string, maxLen = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLen) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

interface SessionDto {
  id: number;
  vaultPath: string;
  title: string;
  mode: string;
  contextScope: ContextScope;
  createdAt: number;
  updatedAt: number;
}

interface MessageDto {
  id: number;
  sessionId: number;
  role: string;
  content: string;
  reasoning: string | null;
  createdAt: number;
}

function toSessionDto(r: ChatSessionRow): SessionDto {
  return {
    id: r.id,
    vaultPath: r.vault_path,
    title: r.title,
    mode: r.mode,
    contextScope: parseScope(r.context_scope),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toMessageDto(r: ChatMessageRow): MessageDto {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    reasoning: r.reasoning ?? null,
    createdAt: r.created_at,
  };
}

export function registerChatHandlers(): void {
  ipcMain.handle(Channels.ListSessions, async (_e, vaultPath: string): Promise<SessionDto[]> => {
    const resolved = assertVaultPath(vaultPath);
    return listSessions(resolved).map(toSessionDto);
  });

  ipcMain.handle(
    Channels.CreateSession,
    async (
      _e,
      input: { vaultPath: string; title: string; mode: string; contextScope?: unknown },
    ): Promise<SessionDto> => {
      if (!input || typeof input !== 'object') throw new Error('Invalid payload');
      const resolved = assertVaultPath(input.vaultPath);
      const title = assertString(input.title, 'title', 512);
      const mode = assertString(input.mode, 'mode', 64);
      if (!ALLOWED_MODES.has(mode)) throw new Error('Invalid mode');
      const scope =
        input.contextScope === undefined
          ? { ...EMPTY_CONTEXT_SCOPE }
          : validateScope(input.contextScope);
      return toSessionDto(
        createSession({ vaultPath: resolved, title, mode, contextScope: JSON.stringify(scope) }),
      );
    },
  );

  ipcMain.handle(Channels.GetMessages, async (_e, sessionId: number): Promise<MessageDto[]> => {
    const id = assertNumber(sessionId, 'sessionId');
    return getMessages(id).map(toMessageDto);
  });

  ipcMain.handle(
    Channels.AppendMessage,
    async (
      _e,
      input: { sessionId: number; role: string; content: string; reasoning?: string | null },
    ): Promise<MessageDto> => {
      if (!input || typeof input !== 'object') throw new Error('Invalid payload');
      const sessionId = assertNumber(input.sessionId, 'sessionId');
      const role = assertString(input.role, 'role', 32);
      if (!ALLOWED_ROLES.has(role)) throw new Error('Invalid role');
      if (typeof input.content !== 'string') throw new Error('Invalid content');
      if (input.reasoning != null && typeof input.reasoning !== 'string') {
        throw new Error('Invalid reasoning');
      }
      // Verify session exists to give a useful error instead of a FK violation.
      const session = getSession(sessionId);
      if (!session) throw new Error('Session not found');
      return toMessageDto(
        appendMessage({ sessionId, role, content: input.content, reasoning: input.reasoning }),
      );
    },
  );

  ipcMain.handle(
    Channels.RenameSession,
    async (_e, sessionId: number, title: string): Promise<void> => {
      const id = assertNumber(sessionId, 'sessionId');
      const t = assertString(title, 'title', 512);
      renameSession(id, t);
    },
  );

  ipcMain.handle(Channels.DeleteSession, async (_e, sessionId: number): Promise<void> => {
    const id = assertNumber(sessionId, 'sessionId');
    deleteSession(id);
  });

  ipcMain.handle(
    Channels.SetScope,
    async (_e, input: { sessionId: number; contextScope: unknown }): Promise<void> => {
      if (!input || typeof input !== 'object') throw new Error('Invalid payload');
      const id = assertNumber(input.sessionId, 'sessionId');
      const session = getSession(id);
      if (!session) throw new Error('Session not found');
      const scope = validateScope(input.contextScope);
      updateScope(id, JSON.stringify(scope));
    },
  );
}
