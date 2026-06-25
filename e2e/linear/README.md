# SpecForge Linear E2E harness (`e2e/linear`)

A live-sandbox **end-to-end** test for SpecForge's Linear **push** pipeline. It
assembles the REAL pipeline — `PatAuth` → `LinearGraphQLClient` (real `fetch`) →
`LinearAdapter` → `planPush` → `executePush` — against a **live Linear
workspace**, pushes a small fixture **twice**, verifies coverage + idempotency by
reading the data back from Linear, and then **deletes everything it created**.

It is a standalone, env-gated Node runner modeled on `bench/`. It is **NOT** a
Vitest spec and is **intentionally excluded from the automatic `npm test` / push
/ pull-request CI** — it hits the live Linear API and needs a real credential,
neither of which belongs in the unit suite. Run it on demand: locally against a
throwaway sandbox. It is **not** wired into CI yet, by choice — see [Wiring it
into CI later](#wiring-it-into-ci-later) for the ready-to-drop-in workflow when
you want it.

> ⚠️ **This run CREATES and then DELETES real data** (one Project, several
> Issues, and a few Labels) in the target workspace. Point it at a **throwaway
> sandbox workspace only** — never a real project.

## What it asserts (the 4 acceptance criteria)

1. **Coverage** — push 1 creates all 6 fixture items: the epic as a Linear
   Project, the features/stories as Issues. Each created item reads back via
   `getRemoteState`. The two parent-link paths are both exercised:
   - epic → feature = **container membership** (the feature joins the epic's
     Project via `projectId`; the executor marks it `linked` with no `linkItems`
     call), and
   - feature → story = a **native parent link** (`issueUpdate(parentId)`), which
     the harness confirms by reading the story's Linear `parent.id`.
2. **Criteria & labels** — items with `criteria` fold them into the issue
   description as a marker-bounded `- [ ]` checklist (read back and asserted using
   the exported `CRITERIA_MARKER_START` / `CRITERIA_MARKER_END` constants), and
   item `tags` are synced to Linear labels (read back from the issue).
3. **Idempotency** — push 2, re-planned against the SyncLinks push 1 wrote, skips
   all 6 items (`created === 0`, `updated === 0`, `failed === 0`, `skipped === 6`)
   and creates **no new labels**.
4. **Teardown** — every created Project, Issue, and Label is deleted in a
   `finally`, so nothing leaks even if an assertion fails.

The harness exits **0** only if every assertion passed and no unexpected error
was thrown; otherwise **1** — so it is automation-friendly despite being run by
hand.

## Prerequisites

- **Node** v22+ (the repo targets a current LTS).
- A **Linear sandbox workspace** and a **Personal API key** for it (see below).

## Create a sandbox workspace + PAT

1. In Linear, create (or switch to) a **throwaway workspace** you are comfortable
   creating and deleting issues in. A free personal workspace works well.
2. Note the **team id** that should own the created issues. You can read it from
   the team settings URL, or query the API: `query { teams { nodes { id name } } }`.
3. Mint a **Personal API key**: Linear → **Settings → Security & access →
   Personal API keys**. Copy it (format `lin_api_…`). Treat it like a password.

## Configure

Copy the template to `e2e/linear/.env` and fill it in:

```bash
cp e2e/linear/.env.example e2e/linear/.env
```

```bash
# e2e/linear/.env  (gitignored)
LINEAR_E2E_PAT=lin_api_...
LINEAR_E2E_TEAM_ID=<sandbox team id>
# optional — usually unnecessary; the epic creates its own Project:
#LINEAR_E2E_PROJECT_ID=
```

`e2e/linear/.env` is **gitignored**, so your key stays local. A real shell
environment variable always **wins** over the file, so you can override a value
for a single run without editing it. PowerShell:

```powershell
$env:LINEAR_E2E_PAT     = "lin_api_..."
$env:LINEAR_E2E_TEAM_ID = "<sandbox team id>"
npm run e2e:linear
```

## Run

```bash
npm run e2e:linear
```

`npm run e2e:linear` loads `e2e/linear/.env`, validates the two required vars
(exits **2** with guidance if either is missing — **before** building, so a
misconfig is cheap), builds the harness bundle (`npm run build:e2e:linear`), then
runs `node dist/e2e/linear-e2e.mjs` forwarding the env. Equivalently:

```bash
npm run build:e2e:linear
node dist/e2e/linear-e2e.mjs   # requires LINEAR_E2E_PAT / LINEAR_E2E_TEAM_ID in env
```

Each run uses a **unique run id** baked into every title and a **unique run tag**
on the labels, so this run's artifacts are easy to spot in the Linear UI and
teardown can match exactly the labels it created.

## Wiring it into CI later

This harness is **not** part of the CI pipeline today, on purpose — it needs a
secret credential and a sandbox that aren't set up yet. When you're ready to run
it on demand from GitHub Actions, two steps wire it up:

**1. Provide the credentials** (repo-level):

- **`LINEAR_E2E_PAT`** — repo **secret** (the `lin_api_…` key). Set it once:
  ```bash
  gh secret set LINEAR_E2E_PAT --repo <owner>/<repo>   # paste at the hidden prompt
  ```
- **`LINEAR_E2E_TEAM_ID`** — repo **variable** (the Sandbox team id):
  ```bash
  gh variable set LINEAR_E2E_TEAM_ID --body <sandbox-team-id> --repo <owner>/<repo>
  ```

**2. Drop in the workflow** at `.github/workflows/linear-e2e.yml`:

```yaml
name: Linear E2E (sandbox)

# Manual-only. Hits the LIVE Linear API and CREATES then DELETES real data in a
# throwaway Sandbox team, so it must never run on push / pull_request.
on:
  workflow_dispatch:

permissions:
  contents: read

# Serialize runs: the harness shares one external Sandbox team, so parallel runs
# would collide on label creation / teardown.
concurrency:
  group: linear-e2e-sandbox
  cancel-in-progress: false

jobs:
  e2e:
    name: Linear sandbox push E2E
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run e2e:linear
        env:
          LINEAR_E2E_PAT: ${{ secrets.LINEAR_E2E_PAT }}
          LINEAR_E2E_TEAM_ID: ${{ vars.LINEAR_E2E_TEAM_ID }}
```

Then trigger it from the **Actions** tab → *Linear E2E (sandbox)* → **Run
workflow**, or `gh workflow run "Linear E2E (sandbox)"`. The job passes/fails on
the harness's exit code, and teardown still runs in CI, so the sandbox is left
clean after each run.

## Teardown behavior

After the assertions, a `finally` block deletes everything the run created —
Issues first, then the Project, then the run's Labels — via best-effort
`issueDelete` / `projectDelete` / `issueLabelDelete` mutations. Teardown **never
throws**: per-id failures are caught and printed in a summary, so a cleanup hiccup
can never mask the real PASS/FAIL verdict. Labels are matched conservatively (the
run-tagged label, plus any generic tag label that did **not** already exist before
the run), so a pre-existing team label is never deleted. If teardown reports
failures, remove the leftovers manually in the sandbox.

## Why it's excluded from the automatic `npm test` / push-PR CI

This harness performs **real network I/O against live Linear** and requires a
**secret credential**. Including it in `npm test` (or running it on every push /
pull request) would make the unit suite non-hermetic, slow, flaky, and dependent
on secrets and an external service. The adapter's behavior is unit-tested with a
fake client/adapter elsewhere (`electron/sync/**` specs,
`src/app/shared/sync-executor.spec.ts`); this harness is the on-demand proof that
the same pipeline works against the **real** API — run by hand locally today, or
via the optional `workflow_dispatch` Action you can add later (above).
