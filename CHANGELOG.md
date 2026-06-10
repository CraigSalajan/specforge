# Changelog

All notable changes to SpecForge are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/CraigSalajan/specforge/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/CraigSalajan/specforge/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/CraigSalajan/specforge/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/CraigSalajan/specforge/releases/tag/v0.2.1
