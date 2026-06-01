import { contextBridge, ipcRenderer } from 'electron';

const IpcChannels = {
  SelectVault: 'specforge:select-vault',
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
  SettingsGet: 'specforge:settings-get',
  SettingsGetAll: 'specforge:settings-get-all',
  SettingsSet: 'specforge:settings-set',
  SettingsSetMany: 'specforge:settings-set-many',
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
  AiStreamChunk: 'specforge:ai-stream-chunk',
  AiStreamDone: 'specforge:ai-stream-done',
  AiStreamError: 'specforge:ai-stream-error',
} as const;

interface AiChatMessageDto {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface AiChatRequestOptionsDto {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
}

interface AiChatStreamRequestDto {
  streamId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: AiChatMessageDto[];
  options?: AiChatRequestOptionsDto;
}

interface AiChatCompleteRequestDto {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: AiChatMessageDto[];
  options?: AiChatRequestOptionsDto;
}

interface AiEmbedRequestDto {
  baseUrl: string;
  apiKey: string;
  model: string;
  texts: string[];
}

interface AiEmbedResponseDto {
  vectors: number[][];
  model: string;
  dim: number;
}

interface AiStreamChunkEventDto {
  streamId: string;
  delta: string;
}

interface AiStreamDoneEventDto {
  streamId: string;
  finishReason?: string;
}

interface AiStreamErrorEventDto {
  streamId: string;
  message: string;
}

const api = {
  selectVault: (): Promise<string | null> => ipcRenderer.invoke(IpcChannels.SelectVault),
  listFiles: (vaultPath: string) => ipcRenderer.invoke(IpcChannels.ListFiles, vaultPath),
  readFile: (filePath: string) => ipcRenderer.invoke(IpcChannels.ReadFile, filePath),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke(IpcChannels.WriteFile, filePath, content),
  createFile: (filePath: string) => ipcRenderer.invoke(IpcChannels.CreateFile, filePath),
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

  // Phase 2: settings
  settingsGet: (key: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.SettingsGet, key),
  settingsGetAll: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke(IpcChannels.SettingsGetAll),
  settingsSet: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.SettingsSet, key, value),
  settingsSetMany: (values: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.SettingsSetMany, values),

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
  chatsAppendMessage: (input: { sessionId: number; role: string; content: string }) =>
    ipcRenderer.invoke(IpcChannels.ChatsAppendMessage, input),
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
  aiChatComplete: (req: AiChatCompleteRequestDto): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.AiChatComplete, req),
  aiEmbed: (req: AiEmbedRequestDto): Promise<AiEmbedResponseDto> =>
    ipcRenderer.invoke(IpcChannels.AiEmbed, req),
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
};

contextBridge.exposeInMainWorld('specforge', api);

export type SpecForgePreloadApi = typeof api;
