# SpecForge AI Benchmark (`specforge-bench`)

Benchmarks the SpecForge AI **agentic harness** — the real tool-using loop the app
runs — with [`eval-core`](https://crates.io/crates/eval-core), a small Rust
"pytest-for-agents" framework. `eval-core` loads declarative cases, drives an
agent, and scores what the agent *did* (which tools it called, with what args,
and what it finally said). SpecForge supplies the agent: a thin Rust adapter
that spawns a headless Node runner driving the **same** `runAgenticLoop` the
Angular/Electron app uses in production.

## Architecture

```
  bench/cases/*.ron
        │  (declarative cases: instruction + Expectations)
        ▼
  eval-core: load_cases → run_suite ──────────────► EvalReport (printed)
        │
        ▼
  SpecforgeAgent (Rust, src/specforge_agent.rs)
        │   spawns once, talks JSON-lines over stdio
        │   ⇅  {"instruction":…}  →   ←  {"toolCalls":[…],"finalText":…,"error":…}
        ▼
  dist/bench/harness-runner.mjs   (Node; built from bench/harness/runner.ts)
        │
        ▼
  runAgenticLoop  ◄── the SAME core as the app:
        │           src/app/features/ai/agentic-loop.ts
        │           (shared module, NOT a copy)
        ▼
  OpenAI-compatible model  (real endpoint, or the local mock for the demo)
```

The runner is a single self-contained `.mjs` bundle produced by
`npm run build:bench` (esbuild, see `bench/harness/build.mjs`). It bundles the
production agentic loop, the real system prompt, and all five real tool
schemas/validators — so the model is driven exactly as it is inside the app.

## Prerequisites

- **Node** (v22+; the repo targets Node 24).
- **Rust + cargo** (stable; edition 2024). `cargo build` in `bench/` should be
  clean on first run.

## Quick start — no API key (the demo)

```
npm run bench:demo
```

This runs the **entire** pipeline against a local, deterministic mock model
(`bench/harness/mock-server.mjs`) so you can see the wiring and a real
`eval-core` report **without spending any tokens**. It will:

1. build the runner (`npm run build:bench`),
2. start the in-process mock model on an ephemeral port,
3. run `cargo run` (the eval-core driver) wired to the mock with a throwaway
   temp vault,
4. print the `EvalReport` and exit with cargo's code.

The mock is approximate (it pattern-matches the instruction), so it is not a
measure of model quality — it proves the Rust → Node → loop → model pipeline
runs end-to-end and that every case is scored.

## Real run — against a live model

Copy the template to `bench/.env` and fill in the three required vars:

```
cp bench/.env.example bench/.env
```

```
# bench/.env
SPECFORGE_BENCH_BASE_URL=https://api.openai.com/v1
SPECFORGE_BENCH_API_KEY=sk-...
SPECFORGE_BENCH_MODEL=gpt-4o-mini
```

Then run the benchmark:

```
npm run bench
```

`bench/.env` is **gitignored**, so your key stays local. It's loaded by both
entry points, so this also works if you drive the Rust driver directly:

```
cd bench && cargo run
```

`npm run bench` loads `bench/.env`, validates the three vars (exits 2 with
guidance if any are missing), builds the runner, then runs `cargo run` in
`bench/`. Equivalently you can run the two steps yourself:

```
npm run build:bench
cd bench && cargo run
```

Any OpenAI-compatible `/chat/completions` endpoint works (OpenAI,
`llama-server`, LM Studio, vLLM, etc.) — point `BASE_URL` at its `/v1`.

### Overriding the `.env` ad-hoc

A real shell environment variable always **wins** over `bench/.env`, so you can
override any value for a single run without editing the file. PowerShell:

```powershell
$env:SPECFORGE_BENCH_MODEL = "gpt-4o"
npm run bench
```

bash/zsh:

```bash
SPECFORGE_BENCH_MODEL="gpt-4o" npm run bench
```

You can skip the `.env` file entirely and set all three vars in the shell if you
prefer.

### Optional env vars

Consumed by the Node runner (`bench/harness/runner.ts`):

- `SPECFORGE_BENCH_VAULT` — vault dir for auto-accepted writes (default: a fresh
  temp dir).
- `SPECFORGE_BENCH_DISABLED_TOOLS` — CSV of tool names to withhold from the model.
- `SPECFORGE_BENCH_MAX_CONTEXT_CHARS` — system-prompt context budget (default 8000).
- `SPECFORGE_BENCH_TIMEOUT_MS` — per-request timeout (default 60000).

Consumed by the Rust driver (`bench/src/main.rs`):

- `SPECFORGE_BENCH_RUNNER` — path to the runner `.mjs`
  (default: `../dist/bench/harness-runner.mjs` relative to the crate).
- `SPECFORGE_BENCH_NODE` — the `node` binary (default `node`).
- `SPECFORGE_BENCH_CASES` — the cases directory (default `<crate>/cases`).
- `SPECFORGE_BENCH_RESULTS` — where eval-core persists run records + the
  generated `report.html` (default `<crate>/results`).
- `EVALFORGE_PROJECT_ID` — when set, each run is uploaded to the EvalForge
  dashboard (evalforge.ai) under this project UUID. Unset (default) = no upload.
- `EVALFORGE_API_KEY` — the EvalForge API key (`sk-eval-…`) used to authenticate
  the upload. Keep it secret (put it in the gitignored `bench/.env`).

## Reports

As of `eval-core` 0.2.0, **every run is persisted by eval-core**. After the
cases finish it writes `<results_dir>/<model>_<timestamp>.json` (one record per
run) and (re)generates a self-contained `<results_dir>/report.html` that
accumulates all runs in that dir (newest-first), so you can compare
models/prompts over time. Open the HTML in a browser; it has no external
dependencies.

We don't hand-roll any of this — the Rust driver simply opts in via
`RunMeta::persist_to`, and eval-core does the saving and HTML generation. It
prints a `saved run + report: <path>` line to stderr on each run.

The default results dir is `bench/results/` (gitignored). Override it with
`SPECFORGE_BENCH_RESULTS`. `npm run bench:demo` writes to a **fresh temp dir**
each run (its path, ending in `report.html`, is printed at the end) so the demo
stays hermetic and never touches `bench/results/`.

## Upload to EvalForge (optional)

As of `eval-core` 0.3.0, a run can also POST itself to the hosted **EvalForge**
dashboard ([evalforge.ai](https://evalforge.ai)) right after it finishes, so
results show up online with no manual export — on top of the local
`report.html`. It's **opt-in** and off by default; nothing is sent unless you
configure credentials.

**Enable it:**

1. Sign in at [evalforge.ai](https://evalforge.ai), create or open a **Project**,
   and copy its **Project ID** — a non-secret UUID.
2. Mint an **API key** (format `sk-eval-…`) under your account settings. Treat it
   like a password.
3. Put both in `bench/.env` (gitignored) — or export them in your shell:

```
# bench/.env
EVALFORGE_PROJECT_ID=<your-project-uuid>
EVALFORGE_API_KEY=sk-eval-...
```

Now `npm run bench` uploads every run automatically (you'll see a
`specforge-bench: EvalForge upload target: project <uuid>` line, then eval-core's
own upload confirmation). The upload **reuses the same record** as local
persistence, so the saved JSON and the dashboard share one dedup key —
re-uploading the same run is safe (the server dedups on project + model +
timestamp). An upload failure is **warned, never fatal**: it can't drop the eval
signal or fail the run.

The endpoint is fixed to evalforge.ai (no URL to configure). Uploading is gated
purely on `EVALFORGE_PROJECT_ID`: if it's set but `EVALFORGE_API_KEY` is missing,
eval-core warns and leaves upload disabled while the run still completes. The
`npm run bench:demo` mock run **never** uploads, even if these vars are set.

## Wire protocol (brief)

The Rust adapter spawns the Node runner once and exchanges one JSON line per
case over stdio. **stdout is a pure JSON-lines stream; stderr is logs.**

- Startup: child prints `{"ready":true}` (or `{"ready":false,"error":"…"}` and
  exits).
- Per case: parent writes `{"instruction":"<text>"}\n`; child replies with one
  line `{"toolCalls":[{"name","args":{…}}],"finalText":"…","error":null|"…","rounds":N,"exhaustedToolRounds":bool,"transcript":[…]}`.
- EOF on stdin → child exits 0.

The `transcript` (the case's full conversation minus the constant system
message) is what populates the per-case transcript in eval-core's report.

## Adding a case

### Coverage

The suite exercises **all five harness tools** (`write_file`, `read_file`,
`list_files`, `search_vault`, `use_skill`) and **every `Expectation` operator**
(`CalledTool`, `DidNotCallTool`, `CalledToolWith`, `ToolCallCount`,
`CalledToolsInOrder`, `NoToolCalls`, `FinalTextContains`, `FinalTextEquals`,
`FinalTextMatches`, `FinalNumberEquals`, `NoError`). Two environment caveats are
honest to keep in mind when reading the cases:

- **`search_vault`** runs against a **stubbed (empty) index** in the harness, so
  retrieval returns no matches. The `search-vault` case therefore asserts that
  the model *chose to search* (the call happened), not what it found.
- **`use_skill`** is exercised against **one seeded fixture skill**
  (`mermaid-diagrams`, advertised by the harness — see `bench/harness/tools.ts`).
  Its name is deliberately unrelated to PRD/ADR so no document-authoring case
  invokes it by accident.

Drop a `.ron` file into `bench/cases/`. A file may hold one case or a list of
cases. Schema:

```ron
(
  name: "short-stable-id",            // shows up in the report
  instruction: "the user turn, verbatim",
  expect: [                            // ALL must hold for the case to pass
    CalledTool(tool: "write_file"),
    NoError,
  ],
)
```

### Available `Expectation` variants

- `CalledTool(tool: "...")` — the tool was called at least once (any args).
- `DidNotCallTool(tool: "...")` — the tool was never called.
- `CalledToolWith(tool: "...", args: { ... })` — called with args that **superset**
  the given subset (see the subset note below).
- `ToolCallCount(tool: Some("..."), min: Some(N), max: Some(M))` — call count is
  within `[min, max]` (each optional; `tool: None` counts all calls).
- `CalledToolsInOrder(tools: ["a", "b"])` — these tools appear in this relative
  order (a subsequence; interleaving allowed).
- `NoToolCalls` — the agent made no tool calls (pure reasoning).
- `FinalTextContains(text: "...", case_insensitive: true)` — final reply contains
  the substring.
- `FinalTextEquals(text: "...")` — final reply equals (trimmed) exactly.
- `FinalTextMatches(regex: "...")` — final reply matches the regex.
- `FinalNumberEquals(value: 4.0, tolerance: 0.0)` — the last number in the final
  reply equals `value` within `tolerance`.
- `NoError` — the run reported no error.

### Worked example

```ron
(
  name: "create-prd-calls-write-file",
  instruction: "Create a PRD for a dark-mode toggle and save it under prd/.",
  expect: [
    CalledTool(tool: "write_file"),
    ToolCallCount(tool: Some("write_file"), min: Some(1)),
    NoError,
    FinalTextContains(text: "prd", case_insensitive: true),
  ],
)
```

> **Subset-match note.** `CalledToolWith` matches when the given `args` are a
> JSON **subset** of the actual call (objects recurse key-by-key; scalars and
> whole arrays must match exactly). It is value-equality, **not** prefix — so
> asserting `args: { path: "prd/" }` will never match a real path like
> `prd/dark-mode.md`. Prefer asserting **`CalledTool` + `NoError`** (plus a
> `ToolCallCount`) over pinning exact paths; this keeps cases robust to
> reasonable model variation.

## Fidelity — what is real vs. benchmark-specific

**Faithfully the production harness:**

- The agentic loop itself (`src/app/features/ai/agentic-loop.ts`) — the same
  module the app imports; not a fork.
- The real system prompt assembly + `TOOL_USAGE_PROMPT`
  (`src/app/features/ai/prompts/system-context.ts`).
- All five real tool schemas (`write_file`, `read_file`, `list_files`,
  `search_vault`, `use_skill`) and their real argument validation/execution.
- The same request/response shaping the app sends to the model (mirrors
  `electron/ipc/ai.ts`, including Gemma text-format tool-call parsing).

**Benchmark-specific (not production):**

- A direct-`fetch` chat provider instead of the Electron IPC path
  (`bench/harness/node-chat-provider.ts`); non-streaming (one request per turn).
- Write proposals are **auto-accepted** into a temp vault instead of going
  through the confirm modal — so a later turn can read back what an earlier turn
  wrote.
- Retrieval / the vault DB are **disabled by default** (empty context scope): no
  RAG index, skills disabled. Tool listing/reads are backed by a plain `fs`
  scan of the temp vault.

## Troubleshooting

- **`runner not found at …`** — the Node runner bundle isn't built. Run
  `npm run build:bench` (the `npm run bench` / `npm run bench:demo` scripts do
  this for you).
- **`npm run bench` exits 2 with "Missing required environment variable(s)"** —
  set `SPECFORGE_BENCH_BASE_URL`, `SPECFORGE_BENCH_API_KEY`, and
  `SPECFORGE_BENCH_MODEL` in `bench/.env` (copy `bench/.env.example`) or in the
  shell (see the real-run section). No key? Use `npm run bench:demo`.
- **Connection refused / 404 on a real run** — point `SPECFORGE_BENCH_BASE_URL`
  at a running OpenAI-compatible endpoint's `/v1`, and confirm the model name
  exists on that server.
- **`failed to launch cargo`** — install the Rust toolchain (rustup) and ensure
  `cargo` is on PATH.
```
