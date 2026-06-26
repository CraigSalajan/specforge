import { Injectable } from '@angular/core';
import type {
  AiChatCompleteIpcResult,
  AiChatCompleteRequest,
  AiChatStreamRequest,
  AiEmbedIpcResult,
  AiEmbedRequest,
  AiListModelsIpcResult,
  AiListModelsRequest,
  AiFileChange,
  AiHistoryRecordInput,
  AiMode,
  AiStreamChunkEvent,
  AiStreamDoneEvent,
  AiStreamErrorEvent,
  BacklinkRef,
  ChatRole,
  ChatSession,
  ChatSessionSummary,
  ContextScope,
  DocPropertyMatch,
  EmbeddingUpsertItem,
  ExportPdfPayload,
  ExportPdfResult,
  FileChangeEvent,
  FileNode,
  IndexSearchHit,
  IndexStatus,
  OutgoingLinkRef,
  PendingChunkRef,
  PersistedChatMessage,
  SkillMeta,
  SkillOrigin,
  SpecForgeApi,
  SyncBuildPreviewResult,
  SyncExecutePushResult,
  SyncListProjectsResult,
  SyncListTeamsResult,
  SyncTestConnectionResult,
} from '../shared/types';
import type { Connection } from '../../../electron/sync/connection';

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

  selectDirectory(): Promise<string | null> {
    return this.requireApi().selectDirectory();
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

  createFile(path: string, content?: string): Promise<void> {
    return this.requireApi().createFile(path, content);
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

  // Wikilink index
  linksBacklinks(vaultPath: string, relPath: string): Promise<BacklinkRef[]> {
    return this.requireApi().linksBacklinks(vaultPath, relPath);
  }

  linksOutgoing(vaultPath: string, relPath: string): Promise<OutgoingLinkRef[]> {
    return this.requireApi().linksOutgoing(vaultPath, relPath);
  }

  linksResolve(vaultPath: string, target: string): Promise<string | null> {
    return this.requireApi().linksResolve(vaultPath, target);
  }

  // Document properties (YAML frontmatter index)
  docPropertiesQuery(vaultPath: string, key: string, value: string): Promise<DocPropertyMatch[]> {
    return this.requireApi().docPropertiesQuery(vaultPath, key, value);
  }

  docPropertiesKeys(vaultPath: string): Promise<string[]> {
    return this.requireApi().docPropertiesKeys(vaultPath);
  }

  docPropertiesValues(vaultPath: string, key: string): Promise<string[]> {
    return this.requireApi().docPropertiesValues(vaultPath, key);
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

  // TER-28: per-connection PM credentials (write/clear/status only — never read back)
  connectionSecretSet(
    connectionId: string,
    kind: 'pat' | 'refreshToken',
    token: string,
  ): Promise<void> {
    return this.requireApi().connectionSecretSet(connectionId, kind, token);
  }

  connectionSecretClear(connectionId: string): Promise<void> {
    return this.requireApi().connectionSecretClear(connectionId);
  }

  connectionSecretStatus(connectionId: string, kind: 'pat' | 'refreshToken'): Promise<boolean> {
    return this.requireApi().connectionSecretStatus(connectionId, kind);
  }

  // TER-30: sync engine surface (only connectionId/vaultPath cross the boundary)
  syncTestConnection(connectionId: string): Promise<SyncTestConnectionResult> {
    return this.requireApi().syncTestConnection(connectionId);
  }

  syncBuildPreview(connectionId: string): Promise<SyncBuildPreviewResult> {
    return this.requireApi().syncBuildPreview(connectionId);
  }

  syncExecutePush(connectionId: string): Promise<SyncExecutePushResult> {
    return this.requireApi().syncExecutePush(connectionId);
  }

  syncConnectionList(vaultPath: string): Promise<Connection[]> {
    return this.requireApi().syncConnectionList(vaultPath);
  }

  // TER-31: team/project discovery. The raw PAT crosses for discovery ONLY (the
  // sole credential-over-IPC exception, used before a connection exists).
  syncListTeams(pat: string): Promise<SyncListTeamsResult> {
    return this.requireApi().syncListTeams(pat);
  }

  syncListProjects(pat: string, teamId: string): Promise<SyncListProjectsResult> {
    return this.requireApi().syncListProjects(pat, teamId);
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
    reasoning?: string | null;
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

  aiChatComplete(req: AiChatCompleteRequest): Promise<AiChatCompleteIpcResult> {
    return this.requireApi().aiChatComplete(req);
  }

  aiEmbed(req: AiEmbedRequest): Promise<AiEmbedIpcResult> {
    return this.requireApi().aiEmbed(req);
  }

  aiListModels(req: AiListModelsRequest): Promise<AiListModelsIpcResult> {
    return this.requireApi().aiListModels(req);
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

  // AI Skills
  skillsList(vaultPath?: string): Promise<SkillMeta[]> {
    return this.requireApi().skillsList(vaultPath);
  }

  skillsReadBody(origin: SkillOrigin, name: string, vaultPath?: string): Promise<string> {
    return this.requireApi().skillsReadBody(origin, name, vaultPath);
  }

  skillsReadResource(
    origin: SkillOrigin,
    name: string,
    resourceRelPath: string,
    vaultPath?: string,
  ): Promise<string> {
    return this.requireApi().skillsReadResource(origin, name, resourceRelPath, vaultPath);
  }

  skillsOpenFolder(scope: 'global' | 'local', vaultPath?: string): Promise<void> {
    return this.requireApi().skillsOpenFolder(scope, vaultPath);
  }

  // Export
  exportPdf(payload: ExportPdfPayload): Promise<ExportPdfResult> {
    return this.requireApi().exportPdf(payload);
  }
}
