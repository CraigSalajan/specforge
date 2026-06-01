# SpecForge

A local-first, Obsidian-flavored markdown workspace tuned for software product planning — PRDs, ADRs, implementation plans, design docs — with an AI planning harness wired in.

This is **Phase 3**: Phase 2 plus an OpenAI-compatible AI provider abstraction, streaming chat with vault retrieval, persisted chat sessions, a planning command toolbar, semantic search via embeddings, and a guarded AI file-change confirmation flow with one-step undo.

## Prerequisites

- Node.js 22+ (tested on 24) — required for the built-in `node:sqlite` module
- npm 10+
- Windows / macOS / Linux

## Install

```bash
npm install
```

SpecForge uses Node's built-in `node:sqlite` (the `DatabaseSync` API). No native rebuild step is required — Electron 42 ships with a compatible Node runtime.

## Run (dev)

```bash
npm start
```

This launches:

1. `ng serve` on `http://localhost:4200`
2. After Angular is up, builds the Electron main + preload bundles via `esbuild`
3. Launches Electron pointing at the dev server with DevTools detached

If you want to run pieces individually:

```bash
npm run start:angular     # Angular dev server only
npm run build:electron    # Compile electron/* to dist/electron/
```

## Build (production-ish)

```bash
npm run build             # build:angular then build:electron
```

Outputs:

- `dist/angular/browser/` — Angular bundle (loaded via `file://` in Electron prod mode)
- `dist/electron/main.js`, `dist/electron/preload.js`

Packaging into platform installers (electron-builder) is wired in `devDependencies` but **not** scripted yet.

## What's in Phase 3

Phase 1 and 2 features plus:

- **OpenAI-compatible AI provider** — chat completions and embeddings are issued from the **main process** (`electron/ipc/ai.ts`) using Node's built-in `fetch`, then surfaced to the renderer over IPC. Streaming chat is multiplexed by `streamId`, with `ai:stream-chunk` / `ai:stream-done` / `ai:stream-error` events fired only on the originating window. The renderer's `AbortController` still hooks the stream — abort triggers `ai:chat-abort`, which cancels the upstream fetch. Single `AiProviderService` reads live config from the settings store so toggling base URL / model takes effect without restart.
- **No CORS, narrow CSP** — because the renderer no longer makes external HTTP calls, `connect-src` is back to `'self' ws://localhost:* http://localhost:*` (localhost retained for `ng serve` HMR in dev only). Any OpenAI-compatible provider works regardless of CORS configuration.
- **Streaming chat harness** with markdown rendering, citation badges (clickable to open the cited file), mode dropdown wired to the five `AI_MODES`, session selector header (new/rename/delete), Stop button while streaming, empty state when no API key is set, and inline error display on failed turns.
- **Chat session persistence** — `chat_sessions` and `chat_messages` tables back the harness. User and assistant turns are persisted; system messages are recomposed on every call from live retrieval so a follow-up question never gets a stale context snapshot.
- **Planning command toolbar** — 8 prompt templates living as separate files under `src/app/features/ai/prompts/`:
  - Create PRD → `/prd/`
  - Create ADR → `/adr/`
  - Create Implementation Plan → `/implementation-plans/`
  - Create User Stories → `/prd/` (stories ship next to the PRD they refine)
  - Find Related Docs
  - Identify Open Questions
  - Summarize Current Feature
  - Review Current Draft
- **Structured file proposals** — create-* commands request `response_format: { type: "json_object" }` and the harness parses `{ filename, folder, title, content }` deterministically.
- **AI file-change confirmation flow** — every create/edit goes through `FileChangeProposalComponent`:
  - Editable path input with renderer-side `..` / absolute-path / drive-letter guards (re-validated in main)
  - Windows-safe filename sanitization (`: " < > | * ?` stripped, trailing dots/spaces trimmed, whitespace collapsed)
  - Side-by-side line diff for edits (via the `diff` package)
  - Rendered markdown preview + raw toggle for creates
  - Collision check: existing path on a "create" forces the user to rename or convert to "edit"
  - Apply / Apply-and-open / Cancel buttons
- **AI change ledger + Undo last** — every applied change is recorded in `ai_file_changes` with before/after snapshots. The "Undo last" button in the AI panel reverts the most recent applied change losslessly (create→delete, edit→restore, delete→write-back, rename→swap-back). Cancelled proposals are recorded with `applied=0` for paper trail.
- **Embeddings** — `OpenAiCompatibleEmbeddingProvider` produces vectors, `EmbeddingIndexerService` drives a batched rebuild (batch size 64, input clipped at 6k chars). Vectors are stored as Float32 BLOBs in `embeddings(vector)`. Settings modal exposes a "Rebuild embeddings" button gated by the `ai.embeddingsEnabled` toggle. **Auto-embedding on every save is intentionally deferred** — embeddings only run on explicit rebuild to avoid burning quota during heavy editing sessions.
- **Hybrid retrieval** — `RetrievalService` always runs keyword search via the FTS5 index; when embeddings are enabled it also embeds the query and runs cosine similarity (in JS, in the main process — adequate for the local-vault scale). Results merge via Reciprocal Rank Fusion (k=60) so we don't have to normalize BM25 against cosine scores. If the embedding call fails we silently fall back to keyword-only results.
- **Settings additions** — `ai.topK` (default 6, chunks per retrieval) and `ai.maxContextChars` (default 12000, truncates excerpts proportionally).

### New IPC channels

```
specforge:chats-list-sessions
specforge:chats-create-session
specforge:chats-get-messages
specforge:chats-append-message
specforge:chats-rename-session
specforge:chats-delete-session

specforge:embeddings-upsert
specforge:embeddings-search
specforge:embeddings-list-pending-chunks
specforge:embeddings-clear

specforge:ai-history-list
specforge:ai-history-record
specforge:ai-history-mark-applied
specforge:ai-history-latest-applied

specforge:ai-chat-stream
specforge:ai-chat-abort
specforge:ai-chat-complete
specforge:ai-embed
specforge:ai-stream-chunk
specforge:ai-stream-done
specforge:ai-stream-error
```

All exposed through the `window.specforge` bridge via `contextBridge`.

### Schema additions

Migrations 3 and 4:
- `ai_file_changes` gains `vault_path TEXT NOT NULL DEFAULT ''` and `new_rel_path TEXT` so the change history is keyed by vault and supports rename undo.
- `embeddings(model)` gets an index for fast per-model lookups.

## What's intentionally deferred to Phase 4

- **OS keychain** — move `ai.apiKey` out of the SQLite settings table into `safeStorage` / `keytar`.
- **Auto-embed on save** — for files that already have embeddings, regenerate vectors on save. Phase 3 keeps embeddings strictly on-demand to control cost.
- **Code highlighting** in the markdown preview.
- **Resizable splitter panels** between vault / editor / AI panel.
- **Heading-line jumping for citation badges** — current behavior opens the cited file at the top; the chunker already tracks `start_line`, so jumping is wiring not parsing.
- **electron-builder packaging targets** and signed installers.
- **Multi-window support.**
- **Light-theme CSS token set** (dark-only for now).
- **Persisted mode switches mid-session** — toggling the mode dropdown after creation currently stays renderer-side; the session row's `mode` is set at creation.

## Architecture

A deep dive lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The short version is below.

```
electron/
  main.ts                BrowserWindow + bootstrap, registers all IPC
  preload.ts             contextBridge -> window.specforge (typed API surface)
  db/
    index.ts             open DB, PRAGMAs, run migrations, FTS5 probe
    migrations.ts        raw SQL migrations (initial + fts5 + phase 3 columns)
    repositories/
      files.repo.ts
      chunks.repo.ts
      settings.repo.ts
      chats.repo.ts          (Phase 3)
      embeddings.repo.ts     (Phase 3, cosine search included)
      ai-changes.repo.ts     (Phase 3)
  indexing/
    chunker.ts           pure heading-bounded splitter
    indexer.ts           fs walk + sha256 + chunker + repos + debounced reindex
  ipc/
    dialog.ts            showOpenDialog
    vault.ts             file CRUD with path traversal guard
    watcher.ts           chokidar -> broadcast + debounced reindex hook
    settings.ts          settings:* handlers
    index.ts             index:* handlers (rebuild, status, search)
    chats.ts             chats:* handlers              (Phase 3)
    embeddings.ts        embeddings:* handlers         (Phase 3)
    ai-history.ts        aiHistory:* handlers          (Phase 3)
    ai.ts                ai:chat-stream / ai:chat-abort / ai:chat-complete / ai:embed (Phase 4)
src/app/
  core/                  IPC + vault + settings + index + ui-state services
  shared/                types, IpcChannels, Settings interface
  features/
    vault/               file tree + node component
    editor/              Monaco wrapper + marked preview
    indexing/            index-status header component
    settings/            settings modal (now with topK / maxCtx / embedding rebuild)
    ai/                                (most of Phase 3)
      ai-panel.component.ts         streaming chat + planning command toolbar + Undo
      ai-orchestrator.service.ts    composes prompts, runs streams, parses proposals
      chat.service.ts               session + message signals + persistence
      file-change.service.ts        apply / record / undo file proposals
      file-change-proposal.component.ts  modal with diff and validation
      prompts/                      one .ts file per planning command template
      providers/
        chat.provider.ts             interface
        embedding.provider.ts        interface
        openai-compatible.provider.ts concrete impl (SSE streaming)
        ai-provider.service.ts       factory bound to live settings signals
        retrieval.service.ts         keyword + vector + RRF
        indexing.service.ts          embedding rebuild with progress signal
        vault-storage.ts             narrow re-export of vault IPC
        path-utils.ts                renderer-side path / filename guards
  app.component.ts       three-panel layout + header + modals
  app.config.ts          providers
```

## Conventions

- Angular 21, standalone components, signals everywhere, new control flow (`@if` / `@for` / `@switch`), `inject()`, `OnPush`
- TypeScript strict mode (including `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`)
- Tailwind v4 (PostCSS plugin, CSS-based theme tokens in `src/styles.css`)
- IPC: every channel goes through `IpcChannels` enum in `src/app/shared/types.ts`; renderer never touches Node directly

## Troubleshooting

- **`node:sqlite` import fails**: the host Node / Electron version must be 22+ (Electron 42 is fine). Older versions don't ship the built-in module.
- **CSP blocks the AI provider call**: as of Phase 4 the renderer never makes external HTTP calls — chat and embeddings run in the main process — so the CSP is locked down to `'self'` + localhost and provider URLs are unaffected. If you see a `connect-src` violation, it means new renderer-side network code was introduced; either move it to main or widen the CSP intentionally.
- **"No API key configured" in the AI panel**: open Settings, paste the key, save. The panel listens to the settings signal and refreshes automatically.
- **Embedding rebuild fails partway**: the indexer is idempotent — re-clicking "Rebuild embeddings" re-runs from a clean slate (it clears existing vectors for the active model first). Network errors surface inline under the button.
- **"Undo last" says nothing to undo**: only changes with `applied=1` are eligible. Cancelled proposals are stored with `applied=0` and are not reversible (they were never applied).
- **Tree doesn't refresh after external edit**: confirm `chokidar` was able to bind to the vault directory; some network drives don't emit events reliably — the watcher falls back gracefully but you can hit "Change vault" -> reselect to force a rescan.
- **Monaco fails to load in dev**: hard refresh (`Ctrl+Shift+R`) — Monaco's worker bootstrap can race the initial bundle.
- **"IPC bridge unavailable" in header**: you opened `http://localhost:4200` in a regular browser instead of through `npm start`. Open via Electron.
- **API key location**: stored in `app.getPath('userData')/specforge.db` (the `settings` table). It is **not** encrypted in Phase 3. The OS keychain swap arrives in Phase 4. If you need to wipe it, use the Settings modal to blank it out.

## Security notes

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (so the preload can `require('electron')`).
- Only a typed set of methods (`window.specforge.*`) is exposed.
- Every vault path argument is resolved with `path.resolve` and validated against the active vault root before any filesystem operation.
- AI proposal paths get a second layer of validation in the main process (`assertWithinVault`), so even a malicious renderer cannot escape the vault root.
- The DB lives in `app.getPath('userData')`, not inside the vault — vaults stay portable plain markdown.
