# settings

Phase 2 settings layer.

The `settings-modal.component.ts` renders a modal overlay (toggled via `UiStateService.settingsOpen()`) bound to keys persisted in the SQLite `settings` table via:

- `SettingsService` (renderer) — signals-backed; hydrates from `settings:get-all` on init, writes back through `settings:set-many`.
- `electron/db/repositories/settings.repo.ts` (main) — upserts.

Supported keys:

- `vaultPath` — string
- `theme` — `dark` | `light`
- `ai.baseUrl` — string (e.g. `https://api.openai.com/v1`)
- `ai.apiKey` — string (stored in plain DB — Phase 4 moves to OS keychain)
- `ai.chatModel` — string
- `ai.embeddingModel` — string
- `ai.embeddingsEnabled` — `'true'` | `'false'`

The settings panel also exposes a "Change Vault" button and a "Rebuild Index" affordance.

Legacy `localStorage` `specforge.vaultPath` is migrated into the DB on first run and then cleared.
