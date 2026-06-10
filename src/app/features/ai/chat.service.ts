import { Injectable, computed, inject, signal } from '@angular/core';
import { IpcService } from '../../core/ipc.service';
import { VaultService } from '../../core/vault.service';
import type {
  AiErrorInfo,
  AiMode,
  ChatRole,
  ChatSession,
  ContextScope,
  PersistedChatMessage,
} from '../../shared/types';
import { EMPTY_CONTEXT_SCOPE } from '../../shared/types';

export interface UiChatMessage {
  /** Persisted message id once written to DB. `null` while streaming. */
  id: number | null;
  role: ChatRole;
  content: string;
  /** True while the assistant is mid-stream. */
  streaming: boolean;
  /** Structured error attached to a failed assistant turn. */
  error: AiErrorInfo | null;
  /** Citations associated with the assistant turn (rendered as badges). */
  citations?: ReadonlyArray<{ relPath: string; headingPath: string }>;
  createdAt: number;
}

/**
 * Backs the chat UI with signal-driven state and persists user/assistant
 * turns to the SQLite chat_sessions / chat_messages tables.
 *
 * System messages are NOT persisted — we recompose them per request from
 * live retrieval. See `prompts/system-context.ts` for the rationale.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly ipc = inject(IpcService);
  private readonly vault = inject(VaultService);

  private readonly _sessions = signal<ChatSession[]>([]);
  private readonly _activeSession = signal<ChatSession | null>(null);
  private readonly _messages = signal<UiChatMessage[]>([]);
  private readonly _loading = signal(false);
  private readonly _streaming = signal(false);
  private readonly _error = signal<string | null>(null);
  /** Structured error of the most recent failed AI turn (composer surface). */
  private readonly _turnError = signal<AiErrorInfo | null>(null);
  private readonly _contextScope = signal<ContextScope>(EMPTY_CONTEXT_SCOPE);

  readonly sessions = this._sessions.asReadonly();
  readonly activeSession = this._activeSession.asReadonly();
  readonly messages = this._messages.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly streaming = this._streaming.asReadonly();
  readonly error = this._error.asReadonly();
  readonly turnError = this._turnError.asReadonly();
  readonly contextScope = this._contextScope.asReadonly();
  readonly hasMessages = computed(() => this._messages().length > 0);

  async refreshSessions(): Promise<void> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath || !this.ipc.isAvailable) {
      this._sessions.set([]);
      return;
    }
    try {
      const sessions = await this.ipc.chatsListSessions(vaultPath);
      this._sessions.set(sessions);
    } catch (err) {
      this._error.set(this.toMessage(err));
    }
  }

  async createSession(title: string, mode: AiMode): Promise<ChatSession | null> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath || !this.ipc.isAvailable) return null;
    try {
      const contextScope = this._contextScope();
      const session = await this.ipc.chatsCreateSession({ vaultPath, title, mode, contextScope });
      this._sessions.update((list) => [session, ...list]);
      this._activeSession.set(session);
      this._messages.set([]);
      this._contextScope.set(session.contextScope ?? EMPTY_CONTEXT_SCOPE);
      return session;
    } catch (err) {
      this._error.set(this.toMessage(err));
      return null;
    }
  }

  async openSession(session: ChatSession): Promise<void> {
    this._activeSession.set(session);
    this._contextScope.set(session.contextScope ?? EMPTY_CONTEXT_SCOPE);
    this._loading.set(true);
    this._error.set(null);
    this._turnError.set(null);
    try {
      const persisted = await this.ipc.chatsGetMessages(session.id);
      this._messages.set(persisted.map(toUiMessage));
    } catch (err) {
      this._error.set(this.toMessage(err));
      this._messages.set([]);
    } finally {
      this._loading.set(false);
    }
  }

  closeActiveSession(): void {
    this._activeSession.set(null);
    this._messages.set([]);
    this._error.set(null);
    this._turnError.set(null);
    this._contextScope.set(EMPTY_CONTEXT_SCOPE);
  }

  async renameSession(sessionId: number, title: string): Promise<void> {
    try {
      await this.ipc.chatsRenameSession(sessionId, title);
      this._sessions.update((list) =>
        list.map((s) => (s.id === sessionId ? { ...s, title, updatedAt: Date.now() } : s)),
      );
      const active = this._activeSession();
      if (active && active.id === sessionId) {
        this._activeSession.set({ ...active, title });
      }
    } catch (err) {
      this._error.set(this.toMessage(err));
    }
  }

  async deleteSession(sessionId: number): Promise<void> {
    try {
      await this.ipc.chatsDeleteSession(sessionId);
      this._sessions.update((list) => list.filter((s) => s.id !== sessionId));
      const active = this._activeSession();
      if (active && active.id === sessionId) {
        this.closeActiveSession();
      }
    } catch (err) {
      this._error.set(this.toMessage(err));
    }
  }

  setMode(mode: AiMode): void {
    const active = this._activeSession();
    if (!active) return;
    // Mode is persisted at session creation; mode changes mid-session are
    // currently kept renderer-side only. A dedicated `chats:setMode` IPC
    // would be the right Phase 4 follow-up if mode mutation becomes
    // important to survive restart.
    this._activeSession.set({ ...active, mode });
  }

  /**
   * Updates the additive context scope. Unlike `setMode` (renderer-only), the
   * scope MUST survive restart, so it is persisted via `chats:setScope` when a
   * session is active. The signal is updated optimistically; a failed persist
   * surfaces via `error` but the in-memory scope still applies to this turn.
   */
  async setScope(scope: ContextScope): Promise<void> {
    this._contextScope.set(scope);
    const active = this._activeSession();
    if (active) {
      this._activeSession.set({ ...active, contextScope: scope });
      try {
        await this.ipc.chatsSetScope({ sessionId: active.id, contextScope: scope });
      } catch (err) {
        this._error.set(this.toMessage(err));
      }
    }
  }

  appendLocal(message: UiChatMessage): void {
    this._messages.update((list) => [...list, message]);
  }

  updateLastAssistant(patch: Partial<UiChatMessage>): void {
    this._messages.update((list) => {
      if (list.length === 0) return list;
      const last = list[list.length - 1];
      if (last.role !== 'assistant') return list;
      const next = { ...last, ...patch };
      return [...list.slice(0, -1), next];
    });
  }

  async persistMessage(
    sessionId: number,
    role: ChatRole,
    content: string,
  ): Promise<PersistedChatMessage | null> {
    try {
      return await this.ipc.chatsAppendMessage({ sessionId, role, content });
    } catch (err) {
      this._error.set(this.toMessage(err));
      return null;
    }
  }

  setStreaming(streaming: boolean): void {
    this._streaming.set(streaming);
  }

  setError(error: string | null): void {
    this._error.set(error);
  }

  setTurnError(error: AiErrorInfo | null): void {
    this._turnError.set(error);
  }

  resetForVaultChange(): void {
    this._sessions.set([]);
    this._activeSession.set(null);
    this._messages.set([]);
    this._error.set(null);
    this._turnError.set(null);
    this._streaming.set(false);
    this._contextScope.set(EMPTY_CONTEXT_SCOPE);
  }

  private toMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

function toUiMessage(p: PersistedChatMessage): UiChatMessage {
  return {
    id: p.id,
    role: p.role,
    content: p.content,
    streaming: false,
    error: null,
    createdAt: p.createdAt,
  };
}
