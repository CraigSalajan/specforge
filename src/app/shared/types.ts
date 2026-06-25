import type { Connection } from '../../../electron/sync/connection';

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

  // Export
  ExportPdf: 'specforge:export-pdf',
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
  /**
   * 1-based first line of the matched chunk (its heading line). Optional so
   * payloads produced before line tracking still typecheck; current index
   * searches always populate it.
   */
  startLine?: number;
}

export type SearchResult = IndexSearchHit;

/**
 * A source reference attached to an assistant turn, rendered as a clickable
 * badge. `startLine` (1-based, the cited chunk's heading line) enables
 * jump-to-line; when absent — whole-file citations (pinned files) or
 * citations captured before line tracking — clicking degrades to opening
 * the file without scrolling.
 */
export interface Citation {
  relPath: string;
  headingPath: string;
  startLine?: number;
}

// Wikilink index (backlinks / traceability substrate)

/** A file linking TO the queried file via a resolved wikilink. */
export interface BacklinkRef {
  /** Vault-relative path of the file containing the link. */
  sourceRelPath: string;
  /** 1-based line where the wikilink appears. */
  line: number;
  /** Link target as written (before any `|` alias or `#` fragment). */
  targetRaw: string;
}

/** A wikilink FROM the queried file, resolved or not. */
export interface OutgoingLinkRef {
  /** Link target as written (before any `|` alias or `#` fragment). */
  targetRaw: string;
  /** Resolved vault-relative path, or null when the target does not exist. */
  targetRelPath: string | null;
  /** 1-based line where the wikilink appears. */
  line: number;
}

/** A file whose frontmatter matched a `key = value` property query. */
export interface DocPropertyMatch {
  /** Vault-relative path of the matching file. */
  relPath: string;
}

/**
 * Where a discovered skill comes from: `global` (under userData), `local`
 * (inside the open vault's `.specforge/skills`), or `user` (one of the
 * user-configured `skills.directories`).
 */
export type SkillOrigin = 'global' | 'local' | 'user';

/**
 * Metadata for a discovered AI skill (a folder with a SKILL.md + optional
 * bundled reference files). `dir` is the absolute folder path and `resources`
 * are forward-slash relative paths of bundled `.md`/`.txt`/`.json` files
 * (excluding the top-level SKILL.md). Skill folders may be nested anywhere
 * under their root (e.g. `<root>/team/nested/skill-name/SKILL.md`).
 */
export interface SkillMeta {
  name: string;
  description: string;
  origin: SkillOrigin;
  dir: string;
  resources: string[];
}

export type Theme = 'dark' | 'light';

/**
 * Application settings persisted in the SQLite `settings` table.
 *
 * Notes:
 *  - `ai.apiKey` is stored locally in the DB, encrypted at rest via Electron
 *    `safeStorage` when the OS supports it (it falls back to plaintext on
 *    systems without OS-level encryption, e.g. some Linux setups). The
 *    renderer always sends and receives the plaintext key over IPC.
 *  - `ai.embeddingsEnabled` is stored as the string `'true'` / `'false'`.
 *  - `ai.topK`, `ai.maxContextChars` and `ai.timeoutSeconds` are stored as
 *    decimal strings.
 *  - `ai.timeoutSeconds` bounds connecting and the wait for the first token;
 *    values above the default also extend the mid-stream stall tolerance.
 *    0 disables request timeouts entirely.
 */
export interface Settings {
  vaultPath: string | null;
  theme: Theme;
  'editor.autoSave': boolean;
  'ai.baseUrl': string;
  'ai.apiKey': string;
  'ai.chatModel': string;
  'ai.embeddingModel': string;
  'ai.embeddingsEnabled': boolean;
  'ai.toolsEnabled': boolean;
  'ai.disabledTools': string[];
  'ai.topK': number;
  'ai.maxContextChars': number;
  'ai.timeoutSeconds': number;
  'skills.enabled': boolean;
  'skills.directories': string[];
  'skills.disabledGlobal': string[];
  'skills.disabledLocal': Record<string, string[]>;
  'skills.disabledUser': string[];
  'ui.leftPaneWidth': number;
  'ui.rightPaneWidth': number;
  /**
   * Vault-relative path (forward slashes, original casing) of the file to
   * restore on launch, or null. Per-vault UI state: VaultService clears it
   * when the vault is switched or closed, so it can never reopen a file from
   * a different vault.
   */
  'ui.lastOpenFile': string | null;
  /**
   * Normalized (lowercase, forward-slash) vault-relative paths of collapsed
   * file-tree folders, stored as a JSON array. The tree defaults to
   * all-expanded, so only the collapsed set is persisted. Per-vault UI state:
   * cleared on vault switch/close (same guard as `ui.lastOpenFile`).
   */
  'ui.collapsedFolders': string[];
  /**
   * Vault-relative paths (forward slashes, original casing) of the open
   * editor tabs in tab-bar order, stored as a JSON array. The active tab is
   * tracked separately via `ui.lastOpenFile`. Per-vault UI state: cleared on
   * vault switch/close (same guard as `ui.lastOpenFile`); entries whose files
   * no longer exist are pruned on restore.
   */
  'ui.openTabs': string[];
  /**
   * Per-vault PM connection configs (non-secret target/config), keyed by vault
   * path, stored as a JSON object. Mirrors `skills.disabledLocal`'s
   * vaultPath -> values[] shape. Credentials are stored separately (TER-28);
   * only the `where`/config and `authMode` discriminator live here.
   */
  'pm.connections': Record<string, Connection[]>;
}

export const DEFAULT_SETTINGS: Settings = {
  vaultPath: null,
  theme: 'dark',
  'editor.autoSave': true,
  'ai.baseUrl': 'https://api.openai.com/v1',
  'ai.apiKey': '',
  'ai.chatModel': 'gpt-4o-mini',
  'ai.embeddingModel': 'text-embedding-3-small',
  'ai.embeddingsEnabled': false,
  'ai.toolsEnabled': true,
  'ai.disabledTools': [],
  'ai.topK': 6,
  'ai.maxContextChars': 12000,
  'ai.timeoutSeconds': 30,
  'skills.enabled': true,
  'skills.directories': [],
  'skills.disabledGlobal': [],
  'skills.disabledLocal': {},
  'skills.disabledUser': [],
  'ui.leftPaneWidth': 256,
  'ui.rightPaneWidth': 320,
  'ui.lastOpenFile': null,
  'ui.collapsedFolders': [],
  'ui.openTabs': [],
  'pm.connections': {},
};

export const SETTINGS_KEYS = [
  'vaultPath',
  'theme',
  'editor.autoSave',
  'ai.baseUrl',
  'ai.apiKey',
  'ai.chatModel',
  'ai.embeddingModel',
  'ai.embeddingsEnabled',
  'ai.toolsEnabled',
  'ai.disabledTools',
  'ai.topK',
  'ai.maxContextChars',
  'ai.timeoutSeconds',
  'skills.enabled',
  'skills.directories',
  'skills.disabledGlobal',
  'skills.disabledLocal',
  'skills.disabledUser',
  'ui.leftPaneWidth',
  'ui.rightPaneWidth',
  'ui.lastOpenFile',
  'ui.collapsedFolders',
  'ui.openTabs',
  'pm.connections',
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
  /** Reasoning/"thinking" text, kept separate from `content`; null when absent. */
  reasoning?: string | null;
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
  /**
   * Bound in ms for headers and the first meaningful streamed event; values
   * above the default also extend the mid-stream idle bound. 0 disables all
   * request timeouts.
   */
  timeoutMs?: number;
}

export interface AiChatCompleteRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: AiChatMessage[];
  options?: AiChatRequestOptions;
  /**
   * Optional caller-generated id so the renderer can abort a non-streaming
   * completion through the same abort channel as streams.
   */
  requestId?: string;
  /** Connect bound in ms; 0 waits indefinitely. Values above the default also extend the response bound. */
  timeoutMs?: number;
}

export interface AiEmbedRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  texts: string[];
  /** Connect bound in ms; 0 waits indefinitely. Values above the default also extend the response bound. */
  timeoutMs?: number;
}

export interface AiEmbedResponse {
  vectors: number[][];
  model: string;
  dim: number;
}

export interface AiModelInfo {
  id: string;
  object?: string;
}

export interface AiListModelsRequest {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface AiListModelsResponse {
  models: AiModelInfo[];
}

/** Token usage for an AI call, mirrored from the provider's `usage` block. */
export interface AiTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiStreamChunkEvent {
  streamId: string;
  delta: string;
  /** Incremental reasoning/"thinking" text for this line, when present. */
  reasoning?: string;
}

export interface AiStreamDoneEvent {
  streamId: string;
  finishReason?: string;
  toolCalls?: AiToolCall[];
  /** Token usage for the stream, when the provider reported it. */
  usage?: AiTokenUsage;
}

export interface AiChatCompleteResult {
  content: string | null;
  /** Reasoning/"thinking" text, kept separate from `content`; null when absent. */
  reasoning?: string | null;
  toolCalls?: AiToolCall[];
  finishReason?: string;
  /** Token usage for the call, when the provider reported it. */
  usage?: AiTokenUsage;
}

/**
 * Structured classification of an AI request failure. Mirrors
 * `electron/ipc/ai-error.ts` (kept in sync by hand — `shared/types.ts` stays
 * free of cross-tree imports by convention).
 */
export type AiErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'server'
  | 'bad_request'
  | 'unknown';

export interface AiErrorInfo {
  code: AiErrorCode;
  /** HTTP status when the provider responded with a non-2xx. */
  status?: number;
  /** Parsed `Retry-After` hint for rate-limited requests, in milliseconds. */
  retryAfterMs?: number;
  /** True when retrying the same request can plausibly succeed. */
  retryable: boolean;
  /** Concise human-readable summary (provider message when available). */
  message: string;
}

export interface AiStreamErrorEvent {
  streamId: string;
  /** Legacy human-readable message ('Aborted' marks a user-initiated stop). */
  message: string;
  /** Structured classification; absent only for user-initiated aborts. */
  error?: AiErrorInfo;
}

/**
 * Discriminated results for the non-streaming AI handlers. `ipcMain.handle`
 * rejections are stringified by Electron with an `Error invoking remote
 * method '…'` prefix, so failures travel as data instead.
 */
export type AiChatCompleteIpcResult =
  | { ok: true; data: AiChatCompleteResult }
  | { ok: false; error: AiErrorInfo };

export type AiEmbedIpcResult =
  | { ok: true; data: AiEmbedResponse }
  | { ok: false; error: AiErrorInfo };

export type AiListModelsIpcResult =
  | { ok: true; data: AiListModelsResponse }
  | { ok: false; error: AiErrorInfo };

// PDF export. The renderer sends sanitized HTML; the main process shows the
// save dialog, prints it in a hidden window and writes the file.
export interface ExportPdfPayload {
  html: string;
  title: string;
  defaultFileName: string;
}

export interface ExportPdfResult {
  success: boolean;
  filePath?: string;
  canceled?: boolean;
  error?: string;
}

export interface SpecForgeApi {
  selectVault: () => Promise<string | null>;
  selectDirectory: () => Promise<string | null>;
  listFiles: (vaultPath: string) => Promise<FileNode[]>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  createFile: (path: string, content?: string) => Promise<void>;
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

  // Wikilink index
  linksBacklinks: (vaultPath: string, relPath: string) => Promise<BacklinkRef[]>;
  linksOutgoing: (vaultPath: string, relPath: string) => Promise<OutgoingLinkRef[]>;
  linksResolve: (vaultPath: string, target: string) => Promise<string | null>;

  // Document properties (YAML frontmatter index)
  docPropertiesQuery: (vaultPath: string, key: string, value: string) => Promise<DocPropertyMatch[]>;
  docPropertiesKeys: (vaultPath: string) => Promise<string[]>;
  docPropertiesValues: (vaultPath: string, key: string) => Promise<string[]>;

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
    reasoning?: string | null;
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
  aiChatComplete: (req: AiChatCompleteRequest) => Promise<AiChatCompleteIpcResult>;
  aiEmbed: (req: AiEmbedRequest) => Promise<AiEmbedIpcResult>;
  aiListModels: (req: AiListModelsRequest) => Promise<AiListModelsIpcResult>;
  onAiStreamChunk: (cb: (evt: AiStreamChunkEvent) => void) => () => void;
  onAiStreamDone: (cb: (evt: AiStreamDoneEvent) => void) => () => void;
  onAiStreamError: (cb: (evt: AiStreamErrorEvent) => void) => () => void;

  // AI Skills
  skillsList: (vaultPath?: string) => Promise<SkillMeta[]>;
  skillsReadBody: (origin: SkillOrigin, name: string, vaultPath?: string) => Promise<string>;
  skillsReadResource: (
    origin: SkillOrigin,
    name: string,
    resourceRelPath: string,
    vaultPath?: string,
  ) => Promise<string>;
  skillsOpenFolder: (scope: 'global' | 'local', vaultPath?: string) => Promise<void>;

  // Export
  exportPdf: (payload: ExportPdfPayload) => Promise<ExportPdfResult>;
}

declare global {
  interface Window {
    specforge: SpecForgeApi;
  }
}
