# indexing

Phase 2 indexing layer.

`index-status.component.ts` renders the small header indicator: `N files · M chunks · Last: <time>` with an inline `Rebuild` button. It binds to `IndexService` (renderer) which wraps the `index:*` IPC calls.

The actual indexing lives in the main process:

- `electron/indexing/chunker.ts` — pure heading-bounded markdown splitter (testable).
- `electron/indexing/indexer.ts` — fs walk + sha256 + chunker + repos + debounced reindex hooks for the watcher.
- `electron/ipc/index.ts` — `index:rebuild`, `index:status`, `index:search` handlers.
- `electron/db/repositories/files.repo.ts`, `chunks.repo.ts` — SQL queries.

Search uses SQLite FTS5 if the build supports it (BM25 ranked), falling back transparently to a `LIKE` scorer otherwise.

Phase 3 will add embedding generation and vector similarity search on top of the existing `embeddings` table.
