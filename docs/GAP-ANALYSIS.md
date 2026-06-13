# Gap Analysis — v0.4.0 vs. the original design docs

_Audited 2026-06-12 against `docs/ARCHITECTURE.md` (initial commit), `PRODUCT.md`, and `README.md`. Companion to `docs/ROADMAP.md`, which turns these findings into a prioritized plan._

> **Status note:** this is a point-in-time audit of v0.4.0. The roadmap's Tier 0–2 work shipped the same day and closed many of the gaps below — among them: API-key encryption (§1.5), citation line-jump (§1.4), chat code highlighting (§1.3), the dead Light-theme control (§1.8), in-file find, global search, quick switcher, command palette, outline view, real wikilinks, and a backlinks panel (§3, §4). See `docs/ROADMAP.md` for current status; the text below is preserved as the audit record.

This document answers two questions:

1. Of the features the original docs promised or deferred, which exist today?
2. What has the app grown that the docs never described?

## 1. The "Phase 4 deferred" scorecard

`docs/ARCHITECTURE.md` §14 deferred nine items. Status as of v0.4.0:

| # | Item | Status | Notes |
| --- | --- | --- | --- |
| 1 | electron-builder packaging | ✅ Done, beyond plan | NSIS / dmg / AppImage / deb, Azure Trusted Signing, macOS notarization, auto-update via `electron-updater`, DevTools disabled in release builds |
| 2 | Resizable splitter panels | ✅ Done | Pointer-capture handles both sides, widths persisted (`ui.leftPaneWidth` / `ui.rightPaneWidth`) |
| 3 | Code highlighting in preview | ✅ Mostly done | highlight.js in the live editor and PDF export. **Gap:** AI chat bubbles render code blocks unhighlighted (`ai-panel.component.ts` uses Marked with no highlighter) |
| 4 | Citation badge → jump to heading line | 🟡 Half done | Clicking opens the file but never scrolls. Citation payload drops `start_line` even though the chunker indexes it |
| 5 | `safeStorage` / keytar for `ai.apiKey` | ❌ Missing | Key is plaintext in SQLite (`settings.repo.ts`); the Settings UI admits it |
| 6 | Auto-embed on save | ❌ Missing (deliberate) | Keyword/FTS index auto-updates via the watcher; only the vector side is manual ("Rebuild embeddings") |
| 7 | Multi-window support | ❌ Missing | Single `BrowserWindow` (plus a hidden PDF print window) |
| 8 | Light-theme CSS token set | ❌ Missing — **dead control** | Settings shows a Dark/Light select and `SettingsService` toggles classes, but no `theme-light` CSS exists anywhere. Also a class mismatch: `styles.css` declares the Tailwind variant on `.dark` while the service applies `theme-dark`. Selecting "Light" silently does nothing. Note `DESIGN.md` mandates a dark-only visual system — resolution is to remove the dead control, not ship a light theme |
| 9 | Persisted mid-session mode switches | ❌ Missing, partially obsoleted | Session `mode` is now vestigial; per-turn behavior is the Ask/Edit composer toggle (not persisted) + `ContextScope` (which **is** persisted via `chats:setScope`) |

## 2. Capabilities the docs never described

Everything below shipped between v0.2.x and v0.4.0 and is absent from `docs/ARCHITECTURE.md`:

- **Agentic tool loop** — Ask-mode turns run native function-calling rounds (cap 8), with streamed tool-call delta accumulation in main and an honest "budget exhausted" error.
- **Tool registry** — `write_file` (stages a confirm-modal proposal), `read_file`, `list_files`, `search_vault`, `use_skill`; master switch + per-tool disable list + Settings → Tools tab.
- **Skills system** — `SKILL.md` folders from three origins (global userData, vault `.specforge/skills`, user-configured directories), nested discovery, local-over-global override, per-origin enable/disable UI.
- **PDF export** — editor header button + file-tree context menu; dark theme + syntax highlighting preserved.
- **Auto-save** — 1s debounce, flush on file switch / window close / vault close; prompt-to-save when off.
- **Live disk reload + 3-way merge** — own-write echo filtering, clean adopt, conflict banner ("Keep mine / Use disk"), deleted-on-disk restore.
- **Selection-focused AI** — selection chip in the context bar, selection-scoped edit proposals, selection-sharpened retrieval.
- **Additive context scope** — `@` picker for vault/folder/file scope, persisted per session; replaced mode-gated retrieval.
- **Composer autocomplete** — `/` planning-command picker, `@` context picker in a shared combobox popover.
- **Structured AI error handling** — error taxonomy, friendly copy, Retry / Open Settings actions, partial-reply retention.
- **Request timeouts** — connect / first-token / mid-stream-idle watchdogs, configurable `ai.timeoutSeconds`.
- **Rich live-editor surfaces** — clickable task checkboxes, rendered tables with sanitized inline markdown, code-block copy button, image/link widgets.
- **Editor replacement** — Monaco + preview toggle is gone; the editor is CodeMirror 6 live markdown (`codemirror-live-markdown`) with no separate preview mode.
- **Apply-time merge for AI edits** — proposals computed against a stale base replay onto current disk via 3-way merge.
- **File-tree UX** — context menus, drag-and-drop file move, inline new file/folder, descendant-count delete confirm.
- **Shared dialog system** — input/confirm dialogs + context-menu service replacing native prompts (with three `window.alert` stragglers in the editor).
- **XSS hardening** — DOMPurify on chat HTML and table cells; per-message render cache.

## 3. Built but never surfaced

Data-layer work with no UI on top — cheap wins:

- **AI change ledger.** Every applied/cancelled proposal lands in `ai_file_changes` and `aiHistory:list` IPC exists, but no renderer code calls it. Undo is a blind "Undo last" with no history view.
- **Heading/line data.** `markdown_chunks` stores `heading_path` + `start_line` per chunk — enough to power citation line-jumping and an outline/TOC panel.
- **Full-text search.** `IndexService.search()` works but is only consumed by AI retrieval; there is no user-facing search UI.

## 4. Gaps a power user hits immediately

Given the `PRODUCT.md` audience (Obsidian/VS Code-native planners, "keyboard-first"):

1. **No reachable search.** No global search panel, no quick-open (Ctrl+P), and no in-file find — `@codemirror/search` is not wired, so Ctrl+F does nothing in the editor.
2. **Wikilinks are decorative.** `[[Target]]` renders as a link but doesn't navigate; no `[[` autocomplete; no backlinks; no unresolved-link styling.
3. **Almost no keyboard surface.** Ctrl+S is the only app-level shortcut. No command palette, no new-file shortcut, no pane-focus shortcuts.
4. **One file at a time.** No tabs, no split view; last-open file not restored on restart.
5. **No frontmatter/properties, tags, git integration, or non-AI templates.** "New File" creates an empty `untitled.md`.
6. **File-tree asymmetries.** Folders can't be renamed or dragged; expansion state isn't persisted; no "Reveal in Explorer" / "Copy path".
7. **Inconsistent error surfaces.** `window.alert` in the editor vs. the custom dialog system everywhere else.

## 5. Where `docs/ARCHITECTURE.md` is stale

- §2/§12: describes a **Monaco** editor with a marked preview toggle — replaced by CodeMirror 6 live markdown, no preview pane.
- §12: "no packaging script is shipped" — packaging, signing, notarization, and auto-update all exist.
- §10: the mode-driven chat pipeline predates the agentic tool loop, ContextScope, and the Ask/Edit toggle.
- §11: doesn't cover the tool-call write path (`write_file` staging a proposal the loop awaits) or apply-time 3-way merge.
- §14: the deferred list is now tracked here and in `docs/ROADMAP.md`.

A refresh pass on `ARCHITECTURE.md` is tracked as documentation debt in the roadmap.
