import { contextBridge, ipcRenderer } from 'electron';

const IpcChannels = {
  SelectVault: 'specforge:select-vault',
  SelectDirectory: 'specforge:select-directory',
  ListFiles: 'specforge:list-files',
  ReadFile: 'specforge:read-file',
  WriteFile: 'specforge:write-file',
  CreateFile: 'specforge:create-file',
  CreateFolder: 'specforge:create-folder',
  RenameFile: 'specforge:rename-file',
  DeleteFile: 'specforge:delete-file',
  DeleteFolder: 'specforge:delete-folder',
  FileChange: 'specforge:file-change',
  WatchVault: 'specforge:watch-vault',
  UnwatchVault: 'specforge:unwatch-vault',
  IndexRebuild: 'specforge:index-rebuild',
  IndexStatus: 'specforge:index-status',
  IndexSearch: 'specforge:index-search',
  LinksBacklinks: 'specforge:links-backlinks',
  LinksOutgoing: 'specforge:links-outgoing',
  LinksResolve: 'specforge:links-resolve',
  DocPropertiesQuery: 'specforge:doc-properties-query',
  DocPropertiesKeys: 'specforge:doc-properties-keys',
  DocPropertiesValues: 'specforge:doc-properties-values',
  SettingsGet: 'specforge:settings-get',
  SettingsGetAll: 'specforge:settings-get-all',
  SettingsSet: 'specforge:settings-set',
  SettingsSetMany: 'specforge:settings-set-many',
  ConnectionSecretSet: 'specforge:connection-secret-set',
  ConnectionSecretClear: 'specforge:connection-secret-clear',
  ConnectionSecretStatus: 'specforge:connection-secret-status',
  SyncTestConnection: 'specforge:sync-test-connection',
  SyncBuildPreview: 'specforge:sync-build-preview',
  SyncExecutePush: 'specforge:sync-execute-push',
  SyncConnectionList: 'specforge:sync-connection-list',
  SyncListTeams: 'specforge:sync-list-teams',
  SyncListProjects: 'specforge:sync-list-projects',
  ChatsListSessions: 'specforge:chats-list-sessions',
  ChatsCreateSession: 'specforge:chats-create-session',
  ChatsGetMessages: 'specforge:chats-get-messages',
  ChatsAppendMessage: 'specforge:chats-append-message',
  ChatsRenameSession: 'specforge:chats-rename-session',
  ChatsDeleteSession: 'specforge:chats-delete-session',
  ChatsSetScope: 'specforge:chats-set-scope',
  EmbeddingsUpsert: 'specforge:embeddings-upsert',
  EmbeddingsSearch: 'specforge:embeddings-search',
  EmbeddingsListPendingChunks: 'specforge:embeddings-list-pending-chunks',
  EmbeddingsClear: 'specforge:embeddings-clear',
  AiHistoryList: 'specforge:ai-history-list',
  AiHistoryRecord: 'specforge:ai-history-record',
  AiHistoryMarkApplied: 'specforge:ai-history-mark-applied',
  AiHistoryLatestApplied: 'specforge:ai-history-latest-applied',
  AiChatStream: 'specforge:ai-chat-stream',
  AiChatAbort: 'specforge:ai-chat-abort',
  AiChatComplete: 'specforge:ai-chat-complete',
  AiEmbed: 'specforge:ai-embed',
  AiListModels: 'specforge:ai-list-models',
  AiStreamChunk: 'specforge:ai-stream-chunk',
  AiStreamDone: 'specforge:ai-stream-done',
  AiStreamError: 'specforge:ai-stream-error',
  SkillsList: 'specforge:skills-list',
  SkillsReadBody: 'specforge:skills-read-body',
  SkillsReadResource: 'specforge:skills-read-resource',
  SkillsOpenFolder: 'specforge:skills-open-folder',
  ExportPdf: 'specforge:export-pdf',
  ShellOpenExternal: 'specforge:open-external',
} as const;

interface AiToolFunctionDefDto {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface AiToolDefDto {
  type: 'function';
  function: AiToolFunctionDefDto;
}

interface AiToolCallDto {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface AiChatMessageDto {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: AiToolCallDto[];
  tool_call_id?: string;
  name?: string;
}

interface AiChatRequestOptionsDto {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
  tools?: AiToolDefDto[];
  toolChoice?: 'auto' | 'none' | 'required';
}

interface AiChatStreamRequestDto {
  streamId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: AiChatMessageDto[];
  options?: AiChatRequestOptionsDto;
  timeoutMs?: number;
}

interface AiChatCompleteRequestDto {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: AiChatMessageDto[];
  options?: AiChatRequestOptionsDto;
  requestId?: string;
  timeoutMs?: number;
}

interface AiEmbedRequestDto {
  baseUrl: string;
  apiKey: string;
  model: string;
  texts: string[];
  timeoutMs?: number;
}

interface AiEmbedResponseDto {
  vectors: number[][];
  model: string;
  dim: number;
}

interface AiModelInfoDto {
  id: string;
  object?: string;
}

interface AiListModelsRequestDto {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

interface AiListModelsResponseDto {
  models: AiModelInfoDto[];
}

interface AiStreamChunkEventDto {
  streamId: string;
  delta: string;
  reasoning?: string;
}

interface AiStreamDoneEventDto {
  streamId: string;
  finishReason?: string;
  toolCalls?: AiToolCallDto[];
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

interface AiChatCompleteResultDto {
  content: string | null;
  reasoning?: string | null;
  toolCalls?: AiToolCallDto[];
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

interface AiErrorInfoDto {
  code: 'auth' | 'rate_limit' | 'network' | 'timeout' | 'server' | 'bad_request' | 'unknown';
  status?: number;
  retryAfterMs?: number;
  retryable: boolean;
  message: string;
}

type AiChatCompleteIpcResultDto =
  | { ok: true; data: AiChatCompleteResultDto }
  | { ok: false; error: AiErrorInfoDto };

type AiEmbedIpcResultDto = { ok: true; data: AiEmbedResponseDto } | { ok: false; error: AiErrorInfoDto };

type AiListModelsIpcResultDto =
  | { ok: true; data: AiListModelsResponseDto }
  | { ok: false; error: AiErrorInfoDto };

interface AiStreamErrorEventDto {
  streamId: string;
  message: string;
  error?: AiErrorInfoDto;
}

const api = {
  selectVault: (): Promise<string | null> => ipcRenderer.invoke(IpcChannels.SelectVault),
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke(IpcChannels.SelectDirectory),
  listFiles: (vaultPath: string) => ipcRenderer.invoke(IpcChannels.ListFiles, vaultPath),
  readFile: (filePath: string) => ipcRenderer.invoke(IpcChannels.ReadFile, filePath),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke(IpcChannels.WriteFile, filePath, content),
  createFile: (filePath: string, content?: string) =>
    ipcRenderer.invoke(IpcChannels.CreateFile, filePath, content),
  createFolder: (folderPath: string) => ipcRenderer.invoke(IpcChannels.CreateFolder, folderPath),
  renameFile: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke(IpcChannels.RenameFile, oldPath, newPath),
  deleteFile: (filePath: string) => ipcRenderer.invoke(IpcChannels.DeleteFile, filePath),
  deleteFolder: (folderPath: string) => ipcRenderer.invoke(IpcChannels.DeleteFolder, folderPath),
  watchVault: (vaultPath: string) => ipcRenderer.invoke(IpcChannels.WatchVault, vaultPath),
  unwatchVault: () => ipcRenderer.invoke(IpcChannels.UnwatchVault),
  onFileChange: (cb: (evt: { type: string; path: string }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { type: string; path: string }) => cb(payload);
    ipcRenderer.on(IpcChannels.FileChange, handler);
    return () => ipcRenderer.removeListener(IpcChannels.FileChange, handler);
  },

  // Phase 2: indexing
  indexRebuild: (vaultPath: string) => ipcRenderer.invoke(IpcChannels.IndexRebuild, vaultPath),
  indexStatus: (vaultPath: string) => ipcRenderer.invoke(IpcChannels.IndexStatus, vaultPath),
  indexSearch: (
    vaultPath: string,
    query: string,
    limit: number,
    filter?: { folders?: string[]; files?: string[] },
  ) => ipcRenderer.invoke(IpcChannels.IndexSearch, vaultPath, query, limit, filter),

  // Wikilink index
  linksBacklinks: (vaultPath: string, relPath: string) =>
    ipcRenderer.invoke(IpcChannels.LinksBacklinks, vaultPath, relPath),
  linksOutgoing: (vaultPath: string, relPath: string) =>
    ipcRenderer.invoke(IpcChannels.LinksOutgoing, vaultPath, relPath),
  linksResolve: (vaultPath: string, target: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.LinksResolve, vaultPath, target),

  // Document properties (YAML frontmatter index)
  docPropertiesQuery: (vaultPath: string, key: string, value: string) =>
    ipcRenderer.invoke(IpcChannels.DocPropertiesQuery, vaultPath, key, value),
  docPropertiesKeys: (vaultPath: string) =>
    ipcRenderer.invoke(IpcChannels.DocPropertiesKeys, vaultPath),
  docPropertiesValues: (vaultPath: string, key: string) =>
    ipcRenderer.invoke(IpcChannels.DocPropertiesValues, vaultPath, key),

  // Phase 2: settings
  settingsGet: (key: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.SettingsGet, key),
  settingsGetAll: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke(IpcChannels.SettingsGetAll),
  settingsSet: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.SettingsSet, key, value),
  settingsSetMany: (values: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.SettingsSetMany, values),

  // TER-28: per-connection PM credentials (write/clear/status only — never read back)
  connectionSecretSet: (
    connectionId: string,
    kind: 'pat' | 'refreshToken',
    token: string,
  ): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.ConnectionSecretSet, connectionId, kind, token),
  connectionSecretClear: (connectionId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.ConnectionSecretClear, connectionId),
  connectionSecretStatus: (
    connectionId: string,
    kind: 'pat' | 'refreshToken',
  ): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.ConnectionSecretStatus, connectionId, kind),

  // TER-30: sync engine surface (only connectionId/vaultPath cross the boundary —
  // never a credential). test/preview/push return result envelopes; list is bare.
  syncTestConnection: (connectionId: string) =>
    ipcRenderer.invoke(IpcChannels.SyncTestConnection, connectionId),
  syncBuildPreview: (connectionId: string) =>
    ipcRenderer.invoke(IpcChannels.SyncBuildPreview, connectionId),
  syncExecutePush: (connectionId: string) =>
    ipcRenderer.invoke(IpcChannels.SyncExecutePush, connectionId),
  syncConnectionList: (vaultPath: string) =>
    ipcRenderer.invoke(IpcChannels.SyncConnectionList, vaultPath),

  // TER-31: team/project discovery. The raw PAT crosses for discovery ONLY (the
  // one credential-over-IPC exception, used pre-connection); it is never logged,
  // persisted, or returned. Provider is fixed to 'linear' (the only V1 provider).
  syncListTeams: (pat: string) =>
    ipcRenderer.invoke(IpcChannels.SyncListTeams, 'linear', pat),
  syncListProjects: (pat: string, teamId: string) =>
    ipcRenderer.invoke(IpcChannels.SyncListProjects, 'linear', pat, teamId),

  // Phase 3: chats
  chatsListSessions: (vaultPath: string) =>
    ipcRenderer.invoke(IpcChannels.ChatsListSessions, vaultPath),
  chatsCreateSession: (input: {
    vaultPath: string;
    title: string;
    mode: string;
    contextScope?: unknown;
  }) => ipcRenderer.invoke(IpcChannels.ChatsCreateSession, input),
  chatsGetMessages: (sessionId: number) =>
    ipcRenderer.invoke(IpcChannels.ChatsGetMessages, sessionId),
  chatsAppendMessage: (input: {
    sessionId: number;
    role: string;
    content: string;
    reasoning?: string | null;
  }) => ipcRenderer.invoke(IpcChannels.ChatsAppendMessage, input),
  chatsRenameSession: (sessionId: number, title: string) =>
    ipcRenderer.invoke(IpcChannels.ChatsRenameSession, sessionId, title),
  chatsDeleteSession: (sessionId: number) =>
    ipcRenderer.invoke(IpcChannels.ChatsDeleteSession, sessionId),
  chatsSetScope: (input: { sessionId: number; contextScope: unknown }) =>
    ipcRenderer.invoke(IpcChannels.ChatsSetScope, input),

  // Phase 3: embeddings
  embeddingsUpsert: (items: unknown) =>
    ipcRenderer.invoke(IpcChannels.EmbeddingsUpsert, items),
  embeddingsSearch: (input: {
    vaultPath: string;
    vector: number[];
    limit: number;
    model: string;
    filter?: { folders?: string[]; files?: string[] };
  }) => ipcRenderer.invoke(IpcChannels.EmbeddingsSearch, input),
  embeddingsListPendingChunks: (input: { vaultPath: string; model: string; limit: number }) =>
    ipcRenderer.invoke(IpcChannels.EmbeddingsListPendingChunks, input),
  embeddingsClear: (input: { vaultPath: string; model?: string }) =>
    ipcRenderer.invoke(IpcChannels.EmbeddingsClear, input),

  // Phase 3: AI history
  aiHistoryList: (vaultPath: string, limit: number) =>
    ipcRenderer.invoke(IpcChannels.AiHistoryList, vaultPath, limit),
  aiHistoryRecord: (input: unknown) =>
    ipcRenderer.invoke(IpcChannels.AiHistoryRecord, input),
  aiHistoryMarkApplied: (id: number, applied: boolean) =>
    ipcRenderer.invoke(IpcChannels.AiHistoryMarkApplied, id, applied),
  aiHistoryLatestApplied: (vaultPath: string) =>
    ipcRenderer.invoke(IpcChannels.AiHistoryLatestApplied, vaultPath),

  // Phase 4: main-side AI HTTP
  aiChatStream: (req: AiChatStreamRequestDto): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.AiChatStream, req),
  aiChatAbort: (streamId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.AiChatAbort, streamId),
  aiChatComplete: (req: AiChatCompleteRequestDto): Promise<AiChatCompleteIpcResultDto> =>
    ipcRenderer.invoke(IpcChannels.AiChatComplete, req),
  aiEmbed: (req: AiEmbedRequestDto): Promise<AiEmbedIpcResultDto> =>
    ipcRenderer.invoke(IpcChannels.AiEmbed, req),
  aiListModels: (req: AiListModelsRequestDto): Promise<AiListModelsIpcResultDto> =>
    ipcRenderer.invoke(IpcChannels.AiListModels, req),
  onAiStreamChunk: (cb: (evt: AiStreamChunkEventDto) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: AiStreamChunkEventDto) => cb(payload);
    ipcRenderer.on(IpcChannels.AiStreamChunk, handler);
    return () => ipcRenderer.removeListener(IpcChannels.AiStreamChunk, handler);
  },
  onAiStreamDone: (cb: (evt: AiStreamDoneEventDto) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: AiStreamDoneEventDto) => cb(payload);
    ipcRenderer.on(IpcChannels.AiStreamDone, handler);
    return () => ipcRenderer.removeListener(IpcChannels.AiStreamDone, handler);
  },
  onAiStreamError: (cb: (evt: AiStreamErrorEventDto) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: AiStreamErrorEventDto) => cb(payload);
    ipcRenderer.on(IpcChannels.AiStreamError, handler);
    return () => ipcRenderer.removeListener(IpcChannels.AiStreamError, handler);
  },

  // AI Skills
  skillsList: (vaultPath?: string) => ipcRenderer.invoke(IpcChannels.SkillsList, vaultPath),
  skillsReadBody: (origin: 'global' | 'local' | 'user', name: string, vaultPath?: string) =>
    ipcRenderer.invoke(IpcChannels.SkillsReadBody, origin, name, vaultPath),
  skillsReadResource: (
    origin: 'global' | 'local' | 'user',
    name: string,
    resourceRelPath: string,
    vaultPath?: string,
  ) => ipcRenderer.invoke(IpcChannels.SkillsReadResource, origin, name, resourceRelPath, vaultPath),
  skillsOpenFolder: (scope: 'global' | 'local', vaultPath?: string) =>
    ipcRenderer.invoke(IpcChannels.SkillsOpenFolder, scope, vaultPath),

  // Export
  exportPdf: (payload: { html: string; title: string; defaultFileName: string }) =>
    ipcRenderer.invoke(IpcChannels.ExportPdf, payload),

  // Shell: open a validated http(s) URL in the system browser (main-side
  // validates the scheme; never pass arbitrary strings to the OS shell).
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.ShellOpenExternal, url),
};

contextBridge.exposeInMainWorld('specforge', api);

export type SpecForgePreloadApi = typeof api;
