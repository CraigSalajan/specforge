# Changelog

All notable changes to SpecForge are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Document properties: the YAML frontmatter block at the top of a file (`--- … ---`) now renders as an inline property editor instead of raw text. Status shows a draft / review / approved / published dropdown, date fields (created, updated, …) get a date picker, true/false values get checkboxes, lists like `tags` become add/remove chips, and nested properties render as indented, editable sub-groups. You can rename, add, and remove properties; value fields autocomplete from values you've used for the same property in other files (so `tags` suggests your existing tags, never unrelated fields); and Tab moves between the fields. The block is collapsible (collapsed by default, with status and tags surfaced in the summary), your hand-written YAML — comments and key order — is preserved on every edit, and malformed frontmatter falls back to editable source so nothing is ever hidden. New files are seeded with a starter `status: draft` / `created` block. See `docs/FRONTMATTER.md`.
- Docs view: a new view in the left sidebar filters the vault by any frontmatter property — for example, show every document where `status` is `approved`. Pick a property and a value to list the matching files, then click to open.

## [0.5.0] - 2026-06-13

### Added

- Editor tabs: every file you open gets a tab above the editor. Click to switch, middle-click or × to close, drag to reorder, right-click for Close / Close Others / Reopen Closed Tab. Keyboard: Ctrl+W closes, Ctrl+Shift+T reopens the last closed tab, Ctrl+Tab / Ctrl+Shift+Tab (and Ctrl+PgDn / Ctrl+PgUp) cycle. Open tabs are restored on launch, each tab remembers its cursor and scroll position for the session, and undo can no longer step across a file switch.

- Quick switcher (Ctrl+P) and command palette (Ctrl+Shift+P): fuzzy-open any vault file (recent files first), or run app commands — new file/folder, export PDF, rebuild index, toggle panes, focus the editor or AI composer, and more. Type `>` in the switcher to flip into command mode.
- Search across the vault (Ctrl+Shift+F): a new Search view in the left sidebar runs full-text search over your notes, groups matches by file, and opens the matching line on click.
- Outline view: a live table of contents for the open document in the left sidebar — click a heading to jump to it.
- Links view: see every note that links to the open file ("linked mentions") and every link going out of it, with one-click navigation.
- Wikilinks now work like you'd expect: click `[[a link]]` to open it (including `[[Note#Heading]]` jumps), links to files that don't exist yet are styled distinctly and offer to create the file, and typing `[[` autocompletes from your vault.
- Find & replace inside the open document (Ctrl+F).
- AI citations now jump to the cited section: clicking a citation badge opens the file and scrolls to the heading with a brief highlight.
- SpecForge now reopens your last open file on launch, and the file tree remembers which folders you collapsed.
- Mermaid diagrams: ` ```mermaid ` fenced code blocks render as diagrams in the editor (flowcharts, sequence diagrams, state machines, and more), themed to match the app. Click a diagram to edit its source; invalid diagrams show a quiet inline error instead of a broken block. PDF export keeps treating these blocks as code for now.

### Changed

- Code blocks in AI chat replies are now syntax-highlighted, matching the editor and PDF export.
- Editor error notices (save/export/read failures) use the app's dialog system instead of system alert popups.
- Removed the non-functional Light theme option from Settings — SpecForge is dark-only by design.

### Fixed

- Opening a file right after closing every editor tab created the tab but left the editor blank — files now load reliably in that case. Two related edge cases were hardened along with it: opening a file whose contents are byte-identical to what's already shown, and a stale editor view lingering after the file pane had been emptied.

### Security

- The AI provider API key is now encrypted at rest with the operating system's keychain (Electron `safeStorage`) when available. Existing plaintext keys are migrated automatically on first launch; systems without OS-level encryption keep the previous behavior.

## [0.4.0] - 2026-06-12

### Added

- Selection-focused AI: select text in the editor and your next Ask or Edit turn focuses on that selection. A dismissible `Selection · L4–L9` chip appears in the chat context bar so you always know it's in play, edit proposals scope their changes to the selected range (while still returning the complete file for a safe diff), and the selection also sharpens context retrieval.
- Configurable AI request timeout in Settings → AI Provider (default 30 seconds; 0 disables). It bounds connecting and the wait for the first token — larger values also extend the mid-stream stall tolerance — and timeout errors now say which phase timed out.
- The open file now live-reloads when it changes on disk: clean buffers reload in place with cursor and scroll preserved, unsaved edits are merged with the disk version, and true conflicts surface a quiet "Keep mine / Use disk" banner with auto-save suspended. Files deleted on disk keep their buffer with a restore option, and AI proposals merge onto the current disk state instead of overwriting it.

### Changed

- Table cells in the editor now render like the rest of the document: task checkboxes are clickable and toggle the underlying markdown, wikilinks display as links, regular links open in a new tab, and emphasis, strikethrough, and images render properly.

### Security

- Inline markdown rendered inside editor table cells is now sanitized with DOMPurify (XSS hardening), matching the app's other markdown surfaces.

## [0.3.0] - 2026-06-09

### Added

- Export documents to PDF: right-click a file in the vault and select "Export to PDF…", or use the "Export PDF" button in the editor header. The document renders with syntax highlighting and the SpecForge dark theme.
- The editor now auto-saves about a second after you stop typing (on by default — toggle it in Settings → Workspace). Switching files, closing the vault, or closing the window flushes unsaved changes first, and with auto-save off SpecForge prompts you to save instead of silently discarding edits.
- Custom skill directories: point SpecForge at any folder of skills from Settings → Skills. Skills are discovered in nested subfolders (`<dir>/<skill>/SKILL.md` at any depth), show up alongside global and vault skills with their own enable/disable toggles, and vault-local skills still win on name collisions.
- Task checkboxes render in the editor: `- [ ]` and `- [x]` become real checkboxes you can click to toggle, and the markdown source reappears when your cursor is on the line.

### Changed

- AI chat replies are much easier to read: proper heading rhythm, breathing room between paragraphs and list items, styled tables, code blocks, horizontal rules, and preserved line breaks instead of one dense wall of text.
- When an AI request fails, SpecForge now shows a friendly, specific message instead of a raw provider error — authentication problems offer **Open Settings**, transient failures (rate limits, network drops, server errors) offer **Retry**, and the partial reply is kept. Requests also time out cleanly instead of hanging forever on a dead connection.

### Fixed

- `~~strikethrough~~` now renders correctly in chat replies.
- Markdown task checkboxes render properly in chat replies and in AI file-change previews (they were stripped or unstyled before).
- Rapidly switching files can no longer write one file's content into another or lose edits made while a save was in flight.
- The assistant now says honestly when it stops after exhausting its tool-call budget instead of reporting "Done."

## [0.2.2] - 2026-06-01

### Added

- The AI assistant can now create files for you on request — ask it to draft a PRD, ADR, plan, or notes and it writes the markdown directly. Every save still goes through the confirmation dialog, so nothing is written without your approval.
- The AI assistant can now read and search your vault on its own, opening a full document, searching for relevant content, or listing files when the auto-injected context isn't enough. These read-only actions run instantly with no confirmation.
- Skills: reusable instruction sets the assistant loads on demand. Drop a `SKILL.md` folder (plus optional reference files) into the global skills folder or a vault's `.specforge/skills`, and the assistant follows it when relevant. Vault-local skills override global ones of the same name.
- New **Tools** and **Skills** sections in Settings: toggle individual tools on or off, enable or disable skills (globally or per vault), reload the skill list, and open the global or vault skills folder directly.
- An **Enable AI tools** master switch in AI Provider settings (on by default) that turns the assistant's file and vault actions off and falls back to plain chat.

### Changed

- Rewrote the README with product screenshots and a logo, and added the SpecForge License Agreement.

### Fixed

- AI chat replies are now sanitized before display (XSS hardening) and render faster — message HTML is cached, so typing in the composer no longer re-parses every message on each keystroke.
- Stopping or dismissing a pending file proposal no longer leaves the assistant hanging; the stale confirmation dialog is closed and the in-flight turn is released cleanly.

### Security

- DevTools are disabled in published production builds (F12 / Ctrl+Shift+I and the "Toggle Developer Tools" menu item are no-ops in official release builds). Local development and self-built packages keep DevTools available.

[Unreleased]: https://github.com/CraigSalajan/specforge/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/CraigSalajan/specforge/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/CraigSalajan/specforge/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/CraigSalajan/specforge/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/CraigSalajan/specforge/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/CraigSalajan/specforge/releases/tag/v0.2.1
