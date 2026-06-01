import { Injectable } from '@angular/core';
import type {
  AiChatCompleteRequest,
  AiChatStreamRequest,
  AiEmbedRequest,
  AiEmbedResponse,
  AiFileChange,
  AiHistoryRecordInput,
  AiMode,
  AiStreamChunkEvent,
  AiStreamDoneEvent,
  AiStreamErrorEvent,
  ChatRole,
  ChatSession,
  ChatSessionSummary,
  ContextScope,
  EmbeddingUpsertItem,
  FileChangeEvent,
  FileNode,
  IndexSearchHit,
  IndexStatus,
  PendingChunkRef,
  PersistedChatMessage,
  SpecForgeApi,
} from '../shared/types';

@Injectable({ providedIn: 'root' })
export class IpcService {
  private readonly api: SpecForgeApi | null = typeof window !== 'undefined' && window.specforge
    ? window.specforge
    : null;

  readonly isAvailable = this.api !== null;

  private requireApi(): SpecForgeApi {
    if (!this.api) {
      throw new Error('SpecForge IPC bridge is not available. Are you running outside Electron?');
    }
    return this.api;
  }

  selectVault(): Promise<string | null> {
    return this.requireApi().selectVault();
  }

  listFiles(vaultPath: string): Promise<FileNode[]> {
    return this.requireApi().listFiles(vaultPath);
  }

  readFile(path: string): Promise<string> {
    return this.requireApi().readFile(path);
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.requireApi().writeFile(path, content);
  }

  createFile(path: string): Promise<void> {
    return this.requireApi().createFile(path);
  }

  createFolder(path: string): Promise<void> {
    return this.requireApi().createFolder(path);
  }

  renameFile(oldPath: string, newPath: string): Promise<void> {
    return this.requireApi().renameFile(oldPath, newPath);
  }

  deleteFile(path: string): Promise<void> {
    return this.requireApi().deleteFile(path);
  }

  deleteFolder(path: string): Promise<void> {
    return this.requireApi().deleteFolder(path);
  }

  watchVault(vaultPath: string): Promise<void> {
    return this.requireApi().watchVault(vaultPath);
  }

  unwatchVault(): Promise<void> {
    return this.requireApi().unwatchVault();
  }

  onFileChange(cb: (evt: FileChangeEvent) => void): () => void {
    return this.requireApi().onFileChange(cb);
  }

  // Phase 2: indexing
  indexRebuild(vaultPath: string): Promise<IndexStatus> {
    return this.requireApi().indexRebuild(vaultPath);
  }

  indexStatus(vaultPath: string): Promise<IndexStatus> {
    return this.requireApi().indexStatus(vaultPath);
  }

  indexSearch(
    vaultPath: string,
    query: string,
    limit: number,
    filter?: { folders?: string[]; files?: string[] },
  ): Promise<IndexSearchHit[]> {
    return this.requireApi().indexSearch(vaultPath, query, limit, filter);
  }

  // Phase 2: settings
  settingsGet(key: string): Promise<string | null> {
    return this.requireApi().settingsGet(key);
  }

  settingsGetAll(): Promise<Record<string, string>> {
    return this.requireApi().settingsGetAll();
  }

  settingsSet(key: string, value: string): Promise<void> {
    return this.requireApi().settingsSet(key, value);
  }

  settingsSetMany(values: Record<string, string>): Promise<void> {
    return this.requireApi().settingsSetMany(values);
  }

  // Phase 3: chats
  chatsListSessions(vaultPath: string): Promise<ChatSessionSummary[]> {
    return this.requireApi().chatsListSessions(vaultPath);
  }

  chatsCreateSession(input: {
    vaultPath: string;
    title: string;
    mode: AiMode;
    contextScope?: ContextScope;
  }): Promise<ChatSession> {
    return this.requireApi().chatsCreateSession(input);
  }

  chatsGetMessages(sessionId: number): Promise<PersistedChatMessage[]> {
    return this.requireApi().chatsGetMessages(sessionId);
  }

  chatsAppendMessage(input: {
    sessionId: number;
    role: ChatRole;
    content: string;
  }): Promise<PersistedChatMessage> {
    return this.requireApi().chatsAppendMessage(input);
  }

  chatsRenameSession(sessionId: number, title: string): Promise<void> {
    return this.requireApi().chatsRenameSession(sessionId, title);
  }

  chatsDeleteSession(sessionId: number): Promise<void> {
    return this.requireApi().chatsDeleteSession(sessionId);
  }

  chatsSetScope(input: { sessionId: number; contextScope: ContextScope }): Promise<void> {
    return this.requireApi().chatsSetScope(input);
  }

  // Phase 3: embeddings
  embeddingsUpsert(items: EmbeddingUpsertItem[]): Promise<{ written: number }> {
    return this.requireApi().embeddingsUpsert(items);
  }

  embeddingsSearch(input: {
    vaultPath: string;
    vector: number[];
    limit: number;
    model: string;
    filter?: { folders?: string[]; files?: string[] };
  }): Promise<IndexSearchHit[]> {
    return this.requireApi().embeddingsSearch(input);
  }

  embeddingsListPendingChunks(input: {
    vaultPath: string;
    model: string;
    limit: number;
  }): Promise<PendingChunkRef[]> {
    return this.requireApi().embeddingsListPendingChunks(input);
  }

  embeddingsClear(input: { vaultPath: string; model?: string }): Promise<{ removed: number }> {
    return this.requireApi().embeddingsClear(input);
  }

  // Phase 3: AI history
  aiHistoryList(vaultPath: string, limit: number): Promise<AiFileChange[]> {
    return this.requireApi().aiHistoryList(vaultPath, limit);
  }

  aiHistoryRecord(input: AiHistoryRecordInput): Promise<AiFileChange> {
    return this.requireApi().aiHistoryRecord(input);
  }

  aiHistoryMarkApplied(id: number, applied: boolean): Promise<void> {
    return this.requireApi().aiHistoryMarkApplied(id, applied);
  }

  aiHistoryLatestApplied(vaultPath: string): Promise<AiFileChange | null> {
    return this.requireApi().aiHistoryLatestApplied(vaultPath);
  }

  // Phase 4: main-side AI HTTP
  aiChatStream(req: AiChatStreamRequest): Promise<void> {
    return this.requireApi().aiChatStream(req);
  }

  aiChatAbort(streamId: string): Promise<void> {
    return this.requireApi().aiChatAbort(streamId);
  }

  aiChatComplete(req: AiChatCompleteRequest): Promise<string> {
    return this.requireApi().aiChatComplete(req);
  }

  aiEmbed(req: AiEmbedRequest): Promise<AiEmbedResponse> {
    return this.requireApi().aiEmbed(req);
  }

  onAiStreamChunk(cb: (evt: AiStreamChunkEvent) => void): () => void {
    return this.requireApi().onAiStreamChunk(cb);
  }

  onAiStreamDone(cb: (evt: AiStreamDoneEvent) => void): () => void {
    return this.requireApi().onAiStreamDone(cb);
  }

  onAiStreamError(cb: (evt: AiStreamErrorEvent) => void): () => void {
    return this.requireApi().onAiStreamError(cb);
  }
}
