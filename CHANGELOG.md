# Changelog

All notable changes to SpecForge are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/CraigSalajan/specforge/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/CraigSalajan/specforge/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/CraigSalajan/specforge/releases/tag/v0.2.1
