# SpecForge Architecture

This document explains how SpecForge is wired internally. It is the companion to the user-facing `README.md` and the source of truth for "how does X work?" questions.

## 1. Process model

SpecForge is a standard two-process Electron app:

- **Main process** (`electron/`) owns the filesystem, the SQLite database, the file watcher, and every IPC handler. It is the only place that touches Node APIs.
- **Renderer process** (`src/app/`) is an Angular 21 standalone app. It can only reach the OS through the `window.specforge` bridge exposed by the preload script.
- **Preload** (`electron/preload.ts`) sits between them: it runs in a privileged context, calls `contextBridge.exposeInMainWorld('specforge', api)`, and is the *only* code that uses both `electron` (`ipcRenderer`) and the renderer's `window` object.

```
+-----------------+        contextBridge          +------------------+
|                 |  <-------------------------   |                  |
|   Renderer      |      window.specforge.*       |    Preload       |
|   (Angular 21)  |   -------------------------> |  (typed bridge)  |
|                 |                                +------------------+
+-----------------+                                         |
                                                            v
                                                +-------------------------+
                                                |       Main process      |
                                                |  - BrowserWindow        |
                                                |  - DB (node:sqlite)     |
                                                |  - chokidar             |
                                                |  - IPC handlers         |
                                                +-------------------------+
```

`nodeIntegration` is `false`, `contextIsolation` is `true`. The renderer cannot `require('fs')` or `require('electron')`.

## 2. Renderer structure

```
src/app/
  app.component.ts            Three-panel layout host
  app.config.ts               Providers
  core/                       Cross-feature services
    ipc.service.ts            window.specforge bridge wrapper, throws if missing
    vault.service.ts          Active vault path, file tree, active file signals
    settings.service.ts       Hydrated from settings:getAll on bootstrap; signals
    index.service.ts          Wraps index:* IPC, exposes status signal
    ui-state.service.ts       Modal/drawer open/closed signals (settings, proposal)
  shared/
    types.ts                  IpcChannels enum, all DTOs, SpecForgeApi interface
  features/
    vault/                    File tree + recursive node component
    editor/                   Monaco wrapper (lazy import) + marked preview toggle
    indexing/                 Index status header chip
    settings/                 Settings modal
    ai/                       (largest feature)
      ai-panel.component.ts            Chat UI + planning toolbar + Undo
      ai-orchestrator.service.ts       Single chat-turn pipeline
      chat.service.ts                  Session + message state and persistence
      file-change.service.ts           Apply / record / undo proposals
      file-change-proposal.component.ts Modal: diff, validation, collisions
      prompts/                         One file per planning command template
      providers/
        chat.provider.ts                Interface
        embedding.provider.ts           Interface
        openai-compatible.provider.ts   Concrete impl (SSE chat + embeddings)
        ai-provider.service.ts          DI factory bound to settings signals
        retrieval.service.ts            FTS + vector + RRF
        indexing.service.ts             Embedding rebuild with progress signal
        vault-storage.ts                Narrow re-export of vault IPC for AI layer
        path-utils.ts                   Renderer-side path/filename guards
```

The whole renderer uses **standalone components**, **signals** for state, the new control flow (`@if` / `@for` / `@switch`), `inject()` and `OnPush`. No NgModules and no constructor injection except where forced by Angular APIs.

## 3. Main process structure

```
electron/
  main.ts                     BrowserWindow bootstrap + IPC registration
  preload.ts                  contextBridge surface (the only IPC client wiring)
  ipc/
    dialog.ts                 showOpenDialog wrapper for "Open Vault"
    vault.ts                  File CRUD + path traversal guard
    watcher.ts                chokidar watch/unwatch + debounced reindex hook
    settings.ts               settings:* handlers
    index.ts                  index:rebuild / index:status / index:search
    chats.ts                  chats:* handlers (sessions + messages)
    embeddings.ts             embeddings:upsert / search / list-pending / clear
    ai-history.ts             aiHistory:list / record / mark-applied / latest
    ai.ts                     ai:chat-stream / chat-abort / chat-complete / embed
                              (main-side OpenAI HTTP; bypasses CORS)
  db/
    index.ts                  open/migrate/PRAGMA + FTS5 probe (singleton)
    migrations.ts             Raw SQL migrations, applied idempotently
    repositories/
      files.repo.ts
      chunks.repo.ts          Includes FTS5 search with LIKE fallback
      settings.repo.ts
      chats.repo.ts
      embeddings.repo.ts      Includes cosine search (in JS, in main)
      ai-changes.repo.ts
  indexing/
    chunker.ts                Pure heading-bounded splitter
    indexer.ts                fs walk + sha256 + chunker + repo writes
  tsconfig.json
```

The build pipeline is `scripts/build-electron.mjs`, an esbuild driver that bundles `main.ts` and `preload.ts` into CommonJS and externalizes native modules.

## 4. IPC contract

Every IPC channel name lives in a single `IpcChannels` enum in `src/app/shared/types.ts`. Both the preload and the main handlers import the same enum, so renaming a channel is a typed change. The shape of `window.specforge` is described by the `SpecForgeApi` interface in the same file.

**Per-channel guarantees**:

- Every handler validates its inputs.
- Every path argument from the renderer is resolved with `path.resolve` and required to start with the active vault root (set when the user picks a vault). Traversal attempts (`..`), absolute paths outside the vault, and other-drive paths are all rejected at the IPC layer — not just in the renderer.
- Handlers that produce events (`watcher`) broadcast through `webContents.send` to every renderer with a registered listener.

## 5. Vault storage

The vault is **plain markdown files on disk** — fully portable, version-controllable, and editable in any other tool. SpecForge never writes metadata files inside the vault. The vault directory chosen by the user is the only path the renderer can ever address.

State that does *not* belong on the disk lives in the SQLite database at:

```
app.getPath('userData')/specforge.db
```

On Windows that resolves to `%APPDATA%\specforge\specforge.db`. On macOS to `~/Library/Application Support/specforge/specforge.db`. On Linux, `~/.config/specforge/specforge.db`. The vault stays portable.

The watcher uses `chokidar` and re-emits four event types (`add`, `change`, `unlink`, `addDir`, `unlinkDir`) up to the renderer. The renderer debounces tree refreshes by ~150 ms. The same watcher kicks the indexer (~500 ms debounce) so external edits get re-indexed without user action.

## 6. Database

`better-sqlite3` was the original Phase 2 choice but switched to Node's built-in **`node:sqlite`** module (`DatabaseSync`) during Phase 3 to eliminate the native-rebuild headache on Windows. Electron 42 ships a Node 22+ runtime that includes the module. The API surface (`prepare` / `run` / `get` / `all`) is similar enough that the repositories abstract over it without leaking the choice.

PRAGMAs applied on every open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
```

Migrations are idempotent — a `_migrations` bookkeeping table records every applied migration by id. FTS5 is probed at boot and gracefully skipped if unavailable; the chunks repo falls back to a `LIKE`-scored search transparently.

### Schema (current)

```
files               vault_path | rel_path | mtime | size | hash | indexed_at
markdown_chunks     file_id (FK) | heading_path | level | content | start_line | end_line | ord
embeddings          chunk_id (FK UNIQUE) | model | vector BLOB | dim | created_at
chat_sessions       vault_path | title | mode | created_at | updated_at
chat_messages       session_id (FK) | role | content | created_at
ai_file_changes     session_id (FK NULL) | vault_path | rel_path | new_rel_path |
                    change_type | before_content | after_content | applied | created_at
settings            key (PK) | value

markdown_chunks_fts FTS5 virtual table on (content, heading_path) with content-sync triggers
```

## 7. Indexing

The chunker splits markdown into heading-bounded chunks. Each chunk's `heading_path` is a breadcrumb like `"# Title > ## Section > ### Subsection"` — that string is what later gets fed to the LLM as the citation handle. Files with no headings produce one chunk with `level = 0`.

The indexer walks the vault, hashes each file with sha256, and skips re-chunking unchanged files. Re-chunking is destructive at the chunk level (delete-then-insert), which is safe because chunks are derived data — the source of truth is the markdown file itself.

The indexer hooks into the watcher: file changes auto-trigger debounced reindex of the affected file. A "Rebuild Index" button in the settings modal triggers a full vault rebuild.

## 8. Retrieval

`RetrievalService` (renderer) is the unified entry point. Given a query string and the active vault path it returns a ranked list of `IndexSearchHit { relPath, headingPath, excerpt, score }`.

Two retrieval modes run in parallel and merge:

1. **Keyword (always)** — FTS5 BM25 ranking via `index:search`, or LIKE-scored as a fallback if FTS5 isn't available.
2. **Vector (when enabled)** — when `ai.embeddingsEnabled` is true and chunks have embeddings, the renderer asks the embedding provider to embed the query, then calls `embeddings:search` which runs cosine similarity over Float32 BLOBs in the main process.

Results are merged via **Reciprocal Rank Fusion** with `k = 60`. RRF was chosen specifically because BM25 scores and cosine scores live on different scales and aren't directly comparable. RRF only cares about per-source rank, so it sidesteps the normalization problem.

Hits are truncated to fit `ai.maxContextChars` (default 12000) before being inlined into the assistant's system prompt.

## 9. AI provider abstraction

OpenAI-compatible HTTP runs in the **main process**, not the renderer. The renderer keeps the same two interfaces it had before so the orchestrator is unchanged:

```ts
interface ChatProvider {
  chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<ChatChunk>;
  chatComplete(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
}

interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  model: string;
  dim?: number;
}
```

`OpenAiCompatibleChatProvider` (renderer) is now a thin client over IPC:

- Generates a `streamId` (`crypto.randomUUID()`), then invokes `ai:chat-stream` with `{ streamId, baseUrl, apiKey, model, messages, options }`.
- Subscribes to `ai:stream-chunk` / `ai:stream-done` / `ai:stream-error` events, filters by `streamId`, and demuxes them into an internal async queue that the iterator drains.
- Hooks the caller's `AbortSignal` to fire `ai:chat-abort` and tear down listeners.
- `chatComplete` invokes `ai:chat-complete` once and returns the full string. Used by planning commands that ask for `response_format: { type: 'json_object' }`.

`OpenAiCompatibleEmbeddingProvider` invokes `ai:embed` per batch and accumulates vectors.

`electron/ipc/ai.ts` (main) owns the real HTTP:

- POSTs to `${baseUrl}/chat/completions` and `${baseUrl}/embeddings` with `Authorization: Bearer ${apiKey}` using Node's built-in `fetch`.
- Streaming: parses SSE the same way the renderer used to — split on `\n\n`, drop non-`data:` lines, handle `[DONE]`, pull `choices[0].delta.content`. Each chunk goes back via `event.sender.send(channel, payload)` so only the originating window gets the events.
- Maintains a `Map<streamId, AbortController>`. The handler rejects duplicate active stream IDs, removes the entry on done / error / abort, and is also called on `before-quit` to abort every in-flight controller via `disposeAiHandlers()`.
- Validates `baseUrl`, `apiKey`, and `messages` per call; rejects empty values immediately.

A single `AiProviderService` reads live config (`baseUrl`, `apiKey`, `chatModel`, `embeddingModel`) from `SettingsService` signals. Toggling the base URL or model takes effect on the *next* call — no app restart, no service reinitialization.

### CORS / CSP

Moving the HTTP layer to main eliminates CORS entirely. Node's `fetch` has no same-origin policy. Without that, the CSP `connect-src` can shrink back to `'self' ws://localhost:* http://localhost:*` (localhost stays only for the `ng serve` HMR socket in dev). If `connect-src` violations ever appear, it means new renderer-side network code was introduced — either move it to main or widen the policy intentionally.

## 10. AI planning harness

The right-hand panel is built around a single chat orchestrator:

```
User submits message
  -> append + persist user message
  -> if mode in { Answer-from-vault, Edit, Review, Draft-with-context }:
       retrieve top-K chunks for query (FTS + vector + RRF)
       compose system message: instructions + cited context block
     else:
       compose minimal system message
  -> stream chat completion via ChatProvider.chat()
  -> render tokens into the assistant bubble as they arrive
  -> on final chunk: persist the assistant message
  -> if create-* command and JSON mode: parse { filename, folder, title, content }
     and open the FileChangeProposalComponent for confirmation
```

System messages are **recomposed on every turn** rather than persisted. This guarantees a follow-up question retrieves a fresh context snapshot reflecting any vault changes since the previous turn.

Planning commands live as separate `*.prompt.ts` files under `features/ai/prompts/` so they can be tuned independently:

- `create-prd` (→ `/prd/`)
- `create-adr` (→ `/adr/`)
- `create-plan` (→ `/implementation-plans/`)
- `create-stories` (→ `/prd/`, alongside the parent PRD)
- `find-related`
- `open-questions`
- `summarize-feature`
- `review-draft`

Each template can reference `{{activeFileTitle}}`, `{{activeFileContent}}`, `{{vaultContext}}`, and `{{userIntent}}` placeholders, which the orchestrator fills.

## 11. Safety model for AI file changes

This is the most security-sensitive subsystem. Three rules:

1. **No silent writes.** Every create/edit/rename/delete from the AI must pass through `FileChangeProposalComponent` and be explicitly confirmed by the user.
2. **No path escape.** Every path is validated twice — once in the renderer (`features/ai/providers/path-utils.ts`) and again in the main process before any `fs` call.
3. **Reversible.** Every applied change is recorded with both `before_content` and `after_content` snapshots in `ai_file_changes`. The most recent applied change can be losslessly undone via the panel's "Undo last" button.

### Proposal flow

```
AI returns proposal { filename, folder, title, content }
  -> sanitize filename (strip Windows-illegal chars, trim trailing dots/spaces, force .md)
  -> compose relPath = folder + sanitizedFilename
  -> renderer guards: reject `..`, absolute paths, drive letters
  -> check vault for existing file at relPath
     - on "create" + exists: disable Apply, force user to rename or convert to "edit"
  -> open FileChangeProposalComponent:
     - editable path input (re-runs guards on every keystroke)
     - rendered markdown preview + raw toggle (create)
     - unified line diff via `diff` package (edit)
     - Apply / Apply-and-open / Cancel
  -> on Apply:
     - main process re-validates path against active vault root
     - capture before_content (for edits)
     - write file via existing vault IPC
     - insert ai_file_changes row with applied=1
  -> on Cancel:
     - insert ai_file_changes row with applied=0 (audit trail; not reversible)
```

### Undo

"Undo last" finds the most recent `applied=1` row for the active vault and reverses it:

- `create` → delete the file
- `edit` → restore `before_content`
- `delete` → write `before_content` back
- `rename` → swap `rel_path` and `new_rel_path` back

After undo, the row is flipped to `applied=0`. The audit log retains both events because each undo also inserts a fresh history entry (or, depending on configuration, simply flips the flag — see the implementation note in `file-change.service.ts`).

### API key storage

`ai.apiKey` is encrypted at rest with Electron's `safeStorage` (OS keychain) when available. The encryption seam lives in `electron/ipc/secure-settings.ts`: writes store `enc:v1:` + base64 of the encrypted value, reads decrypt transparently, and a one-time idempotent migration on startup rewrites any legacy plaintext key. On systems without OS-level encryption (some Linux setups without a keyring) the value degrades to plaintext rather than losing the key; if a previously encrypted value can no longer be decrypted (e.g. the DB was copied to another machine), it reads as unset and the user re-enters it. The renderer contract is unchanged — plaintext crosses the IPC bridge both ways; encryption is at-rest only.

## 12. Build & packaging

Two build pipelines:

- **Angular** (`ng build --configuration production`) — outputs to `dist/angular/browser/`. Monaco is lazy-loaded so initial bundle stays small (~80 KB transfer).
- **Electron** (`scripts/build-electron.mjs`) — esbuild driver. Bundles `main.ts` and `preload.ts` to CJS, externalizes `electron`, `chokidar`, `fsevents`, and `node:*`. Source maps emitted alongside.

Dev launch (`npm start`) uses `concurrently` to run `ng serve` (port 4200) and `wait-on` to delay Electron until Angular is up. Electron then re-builds its own bundles and loads `http://localhost:4200`. In a production build, Electron loads `file://dist/angular/browser/index.html` instead — `<base href="./">` and Angular's relative output configuration make both work without code changes.

electron-builder is wired as a dev dependency but no packaging script is shipped in this MVP. Adding it is a `build.appId` / `build.win` / `build.mac` block in `package.json` plus a script — deferred to a packaging pass.

## 13. Decisions log (the non-obvious ones)

- **node:sqlite over better-sqlite3** — better-sqlite3 needed a native-module rebuild against Electron's Node ABI, which is painful on fresh Windows machines without VS Build Tools. `node:sqlite` is built into the Node runtime that Electron 42 ships and removes the build dependency entirely. Trade-off: `node:sqlite` is experimental in Node 22.x and stable in Node 24+, so runtime emits a warning. We accept that.
- **RRF over score normalization** for hybrid retrieval — BM25 and cosine live on different scales; normalizing them is fragile, RRF doesn't care.
- **JSON output mode for create-* commands** — much more reliable than parsing fenced code blocks from free-form responses.
- **Recompose system prompt per turn** — keeps retrieval fresh; the alternative (persisting the original system message) silently goes stale.
- **No auto-embed on save** — heavy editing sessions can drain quota fast. Explicit "Rebuild embeddings" only.
- **DB outside the vault** — vaults stay portable plain markdown; sync them with git or any cloud drive without dragging app state along.
- **Modal/drawer settings UI instead of a route** — there's no router yet; modals are the cheap path. If the app grows a settings tree, this can be refactored without touching anything else.

## 14. What's deferred to Phase 4

- `safeStorage` / `keytar` for `ai.apiKey`
- Auto-embed on save (with debounce + opt-in setting)
- Code highlighting in the markdown preview
- Resizable splitter panels
- Heading-line jumping when a citation badge is clicked (chunker already tracks `start_line`)
- electron-builder packaging targets and signed installers
- Multi-window support
- Light-theme CSS token set
- Persisted mid-session mode switches
