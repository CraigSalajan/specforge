# Roadmap

_Written 2026-06-12, informed by the audit in `docs/GAP-ANALYSIS.md` and a survey of the 2025–2026 landscape (Obsidian core + plugin ecosystem, GitHub Spec Kit, AWS Kiro, Cursor Plan Mode, ChatPRD, Linear/ProductBoard, local-first markdown editors)._

## Strategic frame

**Generic markdown/PKM features are table stakes we only need enough of; the spec-to-stories AI workflow is the differentiator nobody else owns locally.** Obsidian owns notes, Cursor/Kiro own code — the PRD → ADR → stories → acceptance-criteria chain in a local, portable vault is open territory. Obsidian's own roadmap is not prioritizing AI, which leaves the gap open.

SpecForge's lane: _what Obsidian is to notes, SpecForge is to specs._

Three converging industry patterns worth leaning into:

- **Markdown as the contract** — specs and plans as durable, AI-readable artifacts, not chat history. SpecForge is already built this way.
- **Traceability by default** — requirement ↔ story ↔ acceptance-criteria links are the backbone of every dedicated planning tool (Linear, ProductBoard, Jama). A wikilink vault makes this natural instead of bureaucratic.
- **Plan artifacts over chat** — agents should produce structured documents the user edits, not transcripts (Cursor Plan Mode, Kiro specs).

## Tier 0 — Fix what's dangling _(shipped 2026-06-12)_

Small, high-trust payoff. Mostly closing gaps the original docs already flagged.

- [x] Remove the dead Light-theme control and fix the `.dark` vs `theme-dark` class mismatch (`DESIGN.md` mandates dark-only; an inert setting violates "quiet by default, clear under pressure")
- [x] In-file find/replace (`@codemirror/search`)
- [x] Syntax-highlight code blocks in AI chat bubbles (highlighter already ships for the editor)
- [x] Citation click scrolls to the heading line (`start_line` is already indexed)
- [x] Replace the editor's `window.alert` calls with the shared dialog system
- [x] Encrypt `ai.apiKey` with Electron `safeStorage` (oldest open security note in the docs)

## Tier 1 — Navigation backbone _(shipped 2026-06-12)_

Table stakes for the stated audience; the backends mostly already exist.

- [x] Quick switcher (Ctrl+P) — fuzzy file open over the existing vault index
- [x] Command palette (Ctrl+Shift+P) — central command registry; the seed of a real keyboard-first surface
- [x] Global search panel over the existing FTS5 index, click-to-open-at-line (Ctrl+Shift+F)
- [x] Outline/TOC panel, click-to-jump (implemented via a renderer-side heading parser reading from disk, not the chunk table)
- [x] Restore last-open file on launch; persist file-tree expansion state

## Tier 2 — Make links real _(shipped 2026-06-12)_

Not PKM polish — the substrate for requirement traceability in Tier 3.

- [x] Link index in the main process (parse `[[wikilinks]]` at index time, SQLite `links` table, IPC for backlinks/outgoing/resolution)
- [x] Wikilink click-to-navigate (incl. `[[Note#Heading]]`); unresolved links styled distinctly with create-on-click
- [x] `[[` autocomplete from vault files (duplicate basenames disambiguate to path form)
- [x] Backlinks panel (Links sidebar view: linked mentions + outgoing links)

## Tier 3 — Planning-specific AI chains _(to be prioritized)_

The differentiator. Candidates, roughly ordered by leverage-per-effort:

- **`/generate-ac`** — Gherkin/EARS acceptance criteria from a story + its PRD context. Kiro and ChatPRD have made this an expected capability; here it is mostly a new prompt file in the existing planning-command system. Low effort, high signal.
- [x] **Document properties/status** (shipped 2026-06-14) — in-editor YAML frontmatter widget (status draft / review / approved / published, owner, dates), a queryable `doc_properties` index, a Docs sidebar filter ("show me all approved specs"), and default-frontmatter seeding on new files.
- **Doc health indicators** — staleness ("PRD untouched 30 days"), completeness ("3 stories missing AC").
- **Traceability queries** — "which stories trace to this requirement?", built on the Tier 2 link index.
- **AI change-history view** — surface the existing `ai_file_changes` ledger with per-entry revert instead of blind "Undo last".
- **AI estimation helper** — one-click S/M/L effort sizing with PRD context.

## Tier 4 — Bigger bets _(to be prioritized)_

Sequence after the core is dense:

- [x] **Tabs** (shipped 2026-06-12) — multi-file tab bar, drag reorder, per-tab cursor/scroll, session restore; **split view** still pending.
- **Git-backed version history** with a diff viewer — fits local-first perfectly; auto-snapshot-on-save is the emerging pattern.
- [x] **Mermaid rendering** (shipped 2026-06-12) — live-preview widget over ```mermaid fences, lazy-loaded, dark-themed; **clipboard image paste** still pending.
- **Canvas / spatial planning view** — expensive; only after the above.
- Remaining deferred items as demand appears: auto-embed on save (opt-in + debounce), multi-window.

## Deliberately skipped

- **Graph view** — admired, rarely used for day-to-day planning; backlinks panel covers the need.
- **Sync / multiplayer / publish** — contradicts local-first positioning; vaults sync fine via git or any drive.
- **Mobile companion** — distraction at this stage.
- **PKM-isms** (daily notes, calendar) — SpecForge is not Obsidian; stay on specs.
- **Light theme** — `DESIGN.md` defines a dark-only system; revisit only with real demand.

## Documentation debt

- [ ] Refresh `docs/ARCHITECTURE.md` (stale sections listed in `docs/GAP-ANALYSIS.md` §5: Monaco → CodeMirror 6, packaging, agentic loop, ContextScope, tool-call write path).
- [ ] Keep this roadmap honest: check items off as they ship, move tiers 3/4 items up as they are prioritized.
