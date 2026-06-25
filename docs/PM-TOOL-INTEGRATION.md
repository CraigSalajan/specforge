# PM Tool Integration — Push Specs to Jira / ADO / Linear / GitHub

_Design discussion captured 2026-06-14. Not yet scheduled; a Tier 4 "bigger bet" candidate in `docs/ROADMAP.md`. This records the architecture decision and its reasoning so we can revisit without re-deriving it._

## Goal

Take the planning artifacts SpecForge produces — the epic → feature → user-story → acceptance-criteria chain — and create the corresponding work items in whatever project-management tool a team uses (Jira, Azure DevOps, Linear, GitHub Projects), with as little friction as possible.

This is the natural downstream of SpecForge's lane (_"what Obsidian is to notes, SpecForge is to specs"_): the spec is authored locally, then handed off to where execution is tracked.

## Decisions already made

Settled during the 2026-06-14 discussion:

1. **Scope: one-way push first**, with idempotent re-push. SpecForge creates and updates items in the PM tool; it stores the external ID on each item so a second push *updates* rather than duplicates. True two-way sync (status/edits flowing back) is explicitly deferred — it needs conflict resolution and change detection and is a separate, larger effort.
2. **Targets: all four** — Jira, Azure DevOps, Linear, GitHub Projects — but sequenced (see [Sequencing](#sequencing)).
3. **There is an in-app agent/chat**, so the conversational path is a real surface to design for, not hypothetical.

## Verdict

**Direct API integration behind a provider-adapter abstraction is the spine. MCP is a complementary surface, not the foundation. CLI tools are avoided entirely.**

The transport choice (the thing that feels like the whole question) is roughly 20% of the work. The value lives in a deterministic **engine** that two surfaces share.

```
Canonical model  →  Adapter interface  →  Sync engine  →  Transport (direct API, main process)
                                              ▲
                          ┌───────────────────┴───────────────────┐
                   Deterministic UI                          Agent (tool-calling)
              (connect → map → preview → push)        "push the auth epic to Jira"
```

### Why, ranked

- **CLI tools — no.** Each user would have to separately install and authenticate `gh`, `az boards`, a community Jira CLI, etc. Fragmented auth, stdout parsing, and every CLI's breaking changes become our support burden. Wrong for a desktop app that controls its own runtime.
- **MCP servers — yes, but as a *surface*, not the *foundation*.** MCP is built to give an LLM/agent tool access, and it shines for the conversational path ("create the backlog in Jira grouped by feature, set points from my estimates"). Atlassian, Linear, and GitHub now ship official (mostly remote) MCP servers. **But** MCP is non-deterministic: bulk-creating dozens of linked items with stable round-trip IDs and idempotent re-runs cannot be a model rolling dice — it can duplicate, drop, or drift.
- **Direct integration — yes, this is the spine.** Adapters run in the Electron main process against each provider's REST/GraphQL API: determinism, idempotency, a real mapping/preview UI, clean one-time OAuth, and a perfect fit for the local-first principle (_the app does the work, the user reviews and disposes_). Cost is per-provider maintenance.

### The key consequence of having an agent

**The agent must call *our* high-level engine tools, not vendor MCP servers directly.** If the deterministic button uses our adapters while the agent uses Atlassian/Linear MCP, we have two code paths to the same action with different behavior — one idempotent with preview, one not. Instead, expose the engine to the agent as tools (e.g. `preview_push(target, selection)` → `commit_push(planId)`). The agent orchestrates and explains; the engine executes with the same guarantees as the button. This reuses the existing agentic tool-call write path. Vendor MCP servers become, at most, an optional adapter *implementation detail* — never a second brain.

## The three things that are the actual work

### 1. A sync-link record (data-model addition)

Idempotent re-push requires every SpecForge item to remember where it went. New table in the main-process DB (`node:sqlite`, alongside the existing index tables):

```ts
SyncLink {
  specItemId:    string   // SpecForge item (epic/feature/story/criterion)
  connectionId:  string   // a configured account+project target
  externalId:    string   // the Jira key / ADO id / Linear id / GitHub node id
  externalUrl:   string   // deep link back, shown in the UI
  lastPushedHash:string   // content hash at last push → "changed since" + skip-unchanged
  lastPushedAt:  string
}
```

Keyed by **connection, not just provider** — the same spec may legitimately push to two Jira projects.

### 2. Hierarchy + field mapping per provider

This dominates the effort and is identical regardless of transport. The four tools diverge hard:

| SpecForge | ADO (cleanest) | Linear (flat) | Jira (hardest) | GitHub Projects (weakest) |
|---|---|---|---|---|
| Epic | Epic | Project / Initiative | Epic (or Initiative w/ Advanced Roadmaps) | Tracking issue / milestone |
| Feature | Feature | Issue + label | Story or sub-Epic | Issue |
| Story | User Story | Issue | Story | Issue + sub-issue |
| Acceptance criteria | Task / checklist | Sub-issue / description | Sub-task / description | Checklist in body |

- **Jira** is the spiky one: required fields vary per project + issue-type, so the adapter must use Jira's create-meta discovery to avoid push failures, and the UI needs a field-mapping step.
- **GitHub Projects** needs the most opinionated mapping because it barely has a native hierarchy (sub-issues are recent).
- The canonical model must **degrade gracefully** per target (collapsing levels where the target is flatter).

### 3. Push-engine mechanics

- **Topological ordering** — create parents, capture their external IDs, then create children with parent links (Jira epic link, ADO `System.Parent` relation, Linear `parentId`, GitHub sub-issues).
- **Dry-run preview tree** — show create / update / skip per item *before* executing. Core to "AI proposes, user disposes."
- **Partial-failure resumability** — a push is N API calls; some fail (missing required field, rate limit). Already-linked items are skipped on re-run, so a mid-batch failure is recoverable, not catastrophic. Respect provider rate limits with backoff.

## Auth & security

- Prefer **OAuth with a loopback / custom-protocol redirect** from the main process, with **PAT / API-key as a power-user fallback** (and the only realistic option for self-hosted Jira/ADO Server).
- Store secrets in the OS keychain via Electron `safeStorage` — never plaintext, never the renderer. This follows the precedent already set for `ai.apiKey`.
- **All provider API calls go through the main process** to avoid CORS and keep tokens out of Angular. The renderer drives the mapping/preview UI over IPC.

## Sequencing

Build the engine + adapter interface properly first, then ship adapters in order of **API/hierarchy friction, not popularity**:

1. **ADO + Linear** — cleanest hierarchy and cleanest APIs; they validate the canonical model with the least mapping pain.
2. **Jira** — once the model is proven, absorb the create-meta / required-field complexity.
3. **GitHub Projects** — last, because its weak hierarchy forces the most opinionated mapping, best decided with the model already battle-tested.

## Open questions to research before building

Provider specifics that change often and should be verified (via `researcher-web`) at implementation time, not answered from memory:

- Current **desktop OAuth flows** for each provider (loopback vs custom protocol; PKCE; token refresh).
- **Jira hierarchy options** — standard Epic→Story→Sub-task vs Initiative→Epic→Story with Advanced Roadmaps, and create-meta required-field discovery.
- **Linear GraphQL** mutations for issue + sub-issue + project/initiative creation and parent linking.
- **GitHub Projects v2** GraphQL — sub-issue support maturity and how best to represent the epic/feature levels (tracking issues vs milestones vs custom fields).
- Current state of **official vendor MCP servers** (Atlassian / Linear / GitHub) — only relevant if we later let an adapter delegate to one.

## Spec format → CanonicalItem (the converter)

SpecForge has no structured spec data model — the vault is portable markdown. The epic → feature → story → acceptance-criteria hierarchy is a **convention** expressed in the markdown the app's own AI prompts produce (`create-stories.prompt.ts` / `create-prd.prompt.ts`). `electron/sync/spec-to-canonical.ts` parses that convention into `CanonicalItem[]` to feed `planPush`.

### Convention parsed

Docs live under the vault's `/prd/` folder (walked recursively, `.md` only, ignored dirs skipped). Per document:

| Markdown | CanonicalItem |
|---|---|
| `# H1` (the doc title) | **epic** — `title` = H1 text; `description` = body between H1 and the first `##`; carries the doc's `tags` |
| `## H2` ("Theme") | **feature** — `title` = H2 text; `description` = the H2 body minus lifted story/criteria content; `parentLocalId` = the epic |
| `As a … I want … so that …` line (case-insensitive; leading `-`/`*`/`+` bullets tolerated) | **story** — `title` = the line; `parentLocalId` = the feature |
| `### H3` (fallback, only when a feature has **no** "As a …" lines) | **story** — `title` = H3 text |
| nested `- Acceptance criteria:` bullet list under a story | the story's `criteria: string[]` (one entry per bullet, in source order) |

Acceptance criteria are **not** emitted as standalone `criterion`-level items — Linear V1 folds them inline (see the `level-mapping.ts` strategy). The `criterion` level value remains valid in the type for future providers. Parsing is fence-aware throughout: a `##` heading, an "As a …" story line, or an "Acceptance criteria:" label inside a code fence is inert (not a feature/story/criterion) and stays in the surrounding description. A doc with no `# H1` is skipped. Non-conforming docs never throw — the converter emits what it can.

### `tags`

Read from frontmatter `tags:` (a `string[]`; a single string is coerced to a one-element array; absent/non-string values are ignored) and attached to that file's **epic** item only. No prompt writes a `tags:` key today — the converter defines that contract.

### `localId` derivation (stable, unique, deterministic)

`localId` maps 1:1 to `SyncLink.specItemId`. It is **not** content-derived (a body edit would orphan the link) and **not** line-number-derived (lines shift on edits). Instead:

- **epic** = the frontmatter `id:` (when present, a non-empty string) **else** the document `relPath`;
- **feature** = `${epicId}#${slug(H2 text)}` — duplicate sibling slugs get a numeric suffix (`-2`, `-3`, …);
- **story** = `${featureId}/${anchor}` — "As a …" stories use a 1-based ordinal (`s1`, `s2`, …) since story lines can be long or duplicated; `### H3`-fallback stories use `slug(H3 text)` with the same sibling disambiguation.

**Rename caveat:** without an explicit frontmatter `id:`, the derived id embeds the `relPath` and heading text, so **renaming a file or editing a heading changes the id** — the next push re-creates the item rather than updating it. Set `id:` in frontmatter to pin an epic's identity across renames.

### Determinism & purity

`collectSpecDocs(root)` sorts docs by `relPath`; within a doc, items emit in source order (epic, then features in heading order, then each feature's stories in source order). The pure core `specToCanonicalItems(docs)` has zero `fs`/DB/network imports (mirrors the deliberately-pure sync engine); the thin reader (`collectSpecDocs` / `buildCanonicalItemsForVault`) takes an explicit `root` — it never resolves the active vault itself (the downstream orchestrator injects it).

## Status / next steps

- **Status:** design captured, not scheduled. Add to `docs/ROADMAP.md` Tier 4 when prioritized.
- **Next step when picked up:** `researcher-web` pass on the open questions above, then a concrete technical design (canonical schema, adapter interface, IPC surface, agent tool definitions), starting with the ADO + Linear adapters.
