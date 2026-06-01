export const IpcChannels = {
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

  // Phase 3
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

  // Phase 4: main-side AI HTTP (fixes CORS by moving fetch out of the renderer)
  AiChatStream: 'specforge:ai-chat-stream',
  AiChatAbort: 'specforge:ai-chat-abort',
  AiChatComplete: 'specforge:ai-chat-complete',
  AiEmbed: 'specforge:ai-embed',
  AiStreamChunk: 'specforge:ai-stream-chunk',
  AiStreamDone: 'specforge:ai-stream-done',
  AiStreamError: 'specforge:ai-stream-error',

  // AI Skills
  SkillsList: 'specforge:skills-list',
  SkillsReadBody: 'specforge:skills-read-body',
  SkillsReadResource: 'specforge:skills-read-resource',
  SkillsOpenFolder: 'specforge:skills-open-folder',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

export interface VaultFile {
  path: string;
  content: string;
}

export type FileChangeType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface FileChangeEvent {
  type: FileChangeType;
  path: string;
}

export type AiMode = 'general' | 'answer-from-vault' | 'draft' | 'edit' | 'review';

export interface AiModeOption {
  value: AiMode;
  label: string;
  description: string;
}

export const AI_MODES: ReadonlyArray<AiModeOption> = [
  { value: 'general', label: 'General', description: 'Open conversation, no vault context' },
  { value: 'answer-from-vault', label: 'Answer from Vault', description: 'Ground answers in vault content' },
  { value: 'draft', label: 'Draft', description: 'Generate new specs and plans' },
  { value: 'edit', label: 'Edit', description: 'Targeted edits to active file' },
  { value: 'review', label: 'Review', description: 'Critique and suggest improvements' },
];

/**
 * Additive context selection for the AI harness. Replaces the old `mode`-based
 * context gating: retrieval/injection are driven by what the user opts into.
 *
 *  - `wholeVault`: search the entire vault index (no path filter).
 *  - `folders`: vault-relative folder prefixes (forward-slash, no trailing `/`).
 *  - `files`: vault-relative file paths (forward-slash) injected verbatim.
 *  - `includeActiveFile`: auto-attach the currently open file as a pinned file.
 */
export interface ContextScope {
  wholeVault: boolean;
  folders: string[];
  files: string[];
  includeActiveFile: boolean;
}

export const EMPTY_CONTEXT_SCOPE: ContextScope = {
  wholeVault: false,
  folders: [],
  files: [],
  includeActiveFile: true,
};

export interface IndexStatus {
  totalFiles: number;
  indexedFiles: number;
  totalChunks: number;
  lastIndexedAt: number | null;
}

export interface IndexSearchHit {
  relPath: string;
  headingPath: string;
  excerpt: string;
  score: number;
}

export type SearchResult = IndexSearchHit;

/**
 * Metadata for a discovered AI skill (a folder with a SKILL.md + optional
 * bundled reference files). `origin` distinguishes global skills (under
 * userData) from local per-vault skills; `dir` is the absolute folder path and
 * `resources` are forward-slash relative paths of bundled `.md`/`.txt`/`.json`
 * files (excluding the top-level SKILL.md).
 */
export interface SkillMeta {
  name: string;
  description: string;
  origin: 'global' | 'local';
  dir: string;
  resources: string[];
}

export type Theme = 'dark' | 'light';

/**
 * Application settings persisted in the SQLite `settings` table.
 *
 * Notes:
 *  - `ai.apiKey` is stored locally in the DB. Phase 4 will move it to the
 *    OS keychain (e.g. `keytar` or Electron `safeStorage`).
 *  - `ai.embeddingsEnabled` is stored as the string `'true'` / `'false'`.
 *  - `ai.topK` and `ai.maxContextChars` are stored as decimal strings.
 */
export interface Settings {
  vaultPath: string | null;
  theme: Theme;
  'ai.baseUrl': string;
  'ai.apiKey': string;
  'ai.chatModel': string;
  'ai.embeddingModel': string;
  'ai.embeddingsEnabled': boolean;
  'ai.toolsEnabled': boolean;
  'ai.disabledTools': string[];
  'ai.topK': number;
  'ai.maxContextChars': number;
  'skills.enabled': boolean;
  'skills.disabledGlobal': string[];
  'skills.disabledLocal': Record<string, string[]>;
  'ui.leftPaneWidth': number;
  'ui.rightPaneWidth': number;
}

export const DEFAULT_SETTINGS: Settings = {
  vaultPath: null,
  theme: 'dark',
  'ai.baseUrl': 'https://api.openai.com/v1',
  'ai.apiKey': '',
  'ai.chatModel': 'gpt-4o-mini',
  'ai.embeddingModel': 'text-embedding-3-small',
  'ai.embeddingsEnabled': false,
  'ai.toolsEnabled': true,
  'ai.disabledTools': [],
  'ai.topK': 6,
  'ai.maxContextChars': 12000,
  'skills.enabled': true,
  'skills.disabledGlobal': [],
  'skills.disabledLocal': {},
  'ui.leftPaneWidth': 256,
  'ui.rightPaneWidth': 320,
};

export const SETTINGS_KEYS = [
  'vaultPath',
  'theme',
  'ai.baseUrl',
  'ai.apiKey',
  'ai.chatModel',
  'ai.embeddingModel',
  'ai.embeddingsEnabled',
  'ai.toolsEnabled',
  'ai.disabledTools',
  'ai.topK',
  'ai.maxContextChars',
  'skills.enabled',
  'skills.disabledGlobal',
  'skills.disabledLocal',
  'ui.leftPaneWidth',
  'ui.rightPaneWidth',
] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

// Phase 3: chat persistence
export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatSession {
  id: number;
  vaultPath: string;
  title: string;
  mode: AiMode;
  contextScope: ContextScope;
  createdAt: number;
  updatedAt: number;
}

export type ChatSessionSummary = ChatSession;

export interface PersistedChatMessage {
  id: number;
  sessionId: number;
  role: ChatRole;
  content: string;
  createdAt: number;
}

// Phase 3: embeddings
export interface EmbeddingUpsertItem {
  chunkId: number;
  model: string;
  vector: number[];
  dim: number;
}

export interface PendingChunkRef {
  chunkId: number;
  relPath: string;
  headingPath: string;
  content: string;
}

// Phase 3: AI change ledger
export type AiChangeType = 'create' | 'edit' | 'rename' | 'delete';

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

export interface AiHistoryRecordInput {
  sessionId: number | null;
  vaultPath: string;
  relPath: string;
  newRelPath?: string | null;
  changeType: AiChangeType;
  beforeContent: string | null;
  afterContent: string | null;
  applied: boolean;
}

// Phase 4: main-side AI HTTP request / event payloads.
// `ChatMessage` is duplicated here (instead of imported from the providers
// folder) to keep `shared/types.ts` free of feature imports.
export interface AiToolFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface AiToolDef {
  type: 'function';
  function: AiToolFunctionDef;
}

export interface AiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: AiToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface AiChatRequestOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
  tools?: AiToolDef[];
  toolChoice?: 'auto' | 'none' | 'required';
}

export interface AiChatStreamRequest {
  streamId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: AiChatMessage[];
  options?: AiChatRequestOptions;
}

export interface AiChatCompleteRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: AiChatMessage[];
  options?: AiChatRequestOptions;
}

export interface AiEmbedRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  texts: string[];
}

export interface AiEmbedResponse {
  vectors: number[][];
  model: string;
  dim: number;
}

export interface AiStreamChunkEvent {
  streamId: string;
  delta: string;
}

export interface AiStreamDoneEvent {
  streamId: string;
  finishReason?: string;
  toolCalls?: AiToolCall[];
}

export interface AiChatCompleteResult {
  content: string | null;
  toolCalls?: AiToolCall[];
  finishReason?: string;
}

export interface AiStreamErrorEvent {
  streamId: string;
  message: string;
}

export interface SpecForgeApi {
  selectVault: () => Promise<string | null>;
  listFiles: (vaultPath: string) => Promise<FileNode[]>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  createFile: (path: string) => Promise<void>;
  createFolder: (path: string) => Promise<void>;
  renameFile: (oldPath: string, newPath: string) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  deleteFolder: (path: string) => Promise<void>;
  watchVault: (vaultPath: string) => Promise<void>;
  unwatchVault: () => Promise<void>;
  onFileChange: (cb: (evt: FileChangeEvent) => void) => () => void;

  // Phase 2: indexing
  indexRebuild: (vaultPath: string) => Promise<IndexStatus>;
  indexStatus: (vaultPath: string) => Promise<IndexStatus>;
  indexSearch: (
    vaultPath: string,
    query: string,
    limit: number,
    filter?: { folders?: string[]; files?: string[] },
  ) => Promise<IndexSearchHit[]>;

  // Phase 2: settings
  settingsGet: (key: string) => Promise<string | null>;
  settingsGetAll: () => Promise<Record<string, string>>;
  settingsSet: (key: string, value: string) => Promise<void>;
  settingsSetMany: (values: Record<string, string>) => Promise<void>;

  // Phase 3: chat persistence
  chatsListSessions: (vaultPath: string) => Promise<ChatSessionSummary[]>;
  chatsCreateSession: (input: {
    vaultPath: string;
    title: string;
    mode: AiMode;
    contextScope?: ContextScope;
  }) => Promise<ChatSession>;
  chatsGetMessages: (sessionId: number) => Promise<PersistedChatMessage[]>;
  chatsAppendMessage: (input: {
    sessionId: number;
    role: ChatRole;
    content: string;
  }) => Promise<PersistedChatMessage>;
  chatsRenameSession: (sessionId: number, title: string) => Promise<void>;
  chatsDeleteSession: (sessionId: number) => Promise<void>;
  chatsSetScope: (input: { sessionId: number; contextScope: ContextScope }) => Promise<void>;

  // Phase 3: embeddings
  embeddingsUpsert: (items: EmbeddingUpsertItem[]) => Promise<{ written: number }>;
  embeddingsSearch: (input: {
    vaultPath: string;
    vector: number[];
    limit: number;
    model: string;
    filter?: { folders?: string[]; files?: string[] };
  }) => Promise<IndexSearchHit[]>;
  embeddingsListPendingChunks: (input: {
    vaultPath: string;
    model: string;
    limit: number;
  }) => Promise<PendingChunkRef[]>;
  embeddingsClear: (input: { vaultPath: string; model?: string }) => Promise<{ removed: number }>;

  // Phase 3: AI history
  aiHistoryList: (vaultPath: string, limit: number) => Promise<AiFileChange[]>;
  aiHistoryRecord: (input: AiHistoryRecordInput) => Promise<AiFileChange>;
  aiHistoryMarkApplied: (id: number, applied: boolean) => Promise<void>;
  aiHistoryLatestApplied: (vaultPath: string) => Promise<AiFileChange | null>;

  // Phase 4: main-side AI HTTP (CORS-free)
  aiChatStream: (req: AiChatStreamRequest) => Promise<void>;
  aiChatAbort: (streamId: string) => Promise<void>;
  aiChatComplete: (req: AiChatCompleteRequest) => Promise<AiChatCompleteResult>;
  aiEmbed: (req: AiEmbedRequest) => Promise<AiEmbedResponse>;
  onAiStreamChunk: (cb: (evt: AiStreamChunkEvent) => void) => () => void;
  onAiStreamDone: (cb: (evt: AiStreamDoneEvent) => void) => () => void;
  onAiStreamError: (cb: (evt: AiStreamErrorEvent) => void) => () => void;

  // AI Skills
  skillsList: (vaultPath?: string) => Promise<SkillMeta[]>;
  skillsReadBody: (origin: 'global' | 'local', name: string, vaultPath?: string) => Promise<string>;
  skillsReadResource: (
    origin: 'global' | 'local',
    name: string,
    resourceRelPath: string,
    vaultPath?: string,
  ) => Promise<string>;
  skillsOpenFolder: (scope: 'global' | 'local', vaultPath?: string) => Promise<void>;
}

declare global {
  interface Window {
    specforge: SpecForgeApi;
  }
}
