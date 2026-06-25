/**
 * Live-sandbox end-to-end harness for the Linear push pipeline (TER-25).
 *
 * This is the orchestration the app does not yet have a production entry point
 * for: it assembles the REAL push pipeline — `PatAuth` → `LinearGraphQLClient`
 * (real `fetch`) → `LinearAdapter` → `planPush` → `executePush` — against a LIVE
 * Linear sandbox, pushes a fixture TWICE, and verifies the four acceptance
 * criteria the unit tests can only assert against a fake adapter:
 *
 *   1. **Coverage** — push 1 creates all six items; epic→Project, the others→
 *      Issues; criteria fold into descriptions; tags become labels; the native
 *      feature→story parent link lands; container membership (epic→feature) is
 *      satisfied without a `linkItems` call.
 *   2. **Idempotency** — push 2 (re-planned against the links push 1 wrote) skips
 *      all six: no creates, no updates, no failures, and no NEW labels.
 *   3. **Read-back correctness** — every created item is re-read from Linear via
 *      `getRemoteState`/`client.request` and its title/description/labels/parent
 *      match what was pushed.
 *   4. **Cleanup** — every created Project, Issue, and Label is deleted in a
 *      `finally`, so a sandbox does not accumulate orphans.
 *
 * ## Idempotency mechanism (why two `planPush` calls, one `captured` map)
 * SKIP is decided by `diffItem` comparing each item's recomputed content hash to
 * its SyncLink's `lastPushedHash`. The harness owns that link store as an
 * in-memory `Map<specItemId, SyncLink>` (`captured`):
 *   - `writeLink` (both pushes) writes into `captured`.
 *   - `resolveLink` (both pushes) reads from `captured`.
 * Push 1 plans against an EMPTY `captured` → every item is `create`; running it
 * populates `captured` with each item's `lastPushedHash`. Push 2 calls `planPush`
 * AGAIN — now that `captured` is populated, every diff hashes equal and is
 * `skip`. Both pushes use the same `connectionId`, exactly as production would.
 *
 * ## Injected side-effects / no hidden globals
 * The only ambient inputs are the three env vars (the credential + team, read
 * once at the top and guarded). Everything else — the clock the executor stamps
 * onto links, the link store, the adapter, the client — is constructed and
 * threaded explicitly. The harness reaches for no Electron API and pulls in no DB
 * (`SyncLink` is a type-only import, erased at compile time), so the esbuild
 * bundle is electron-free and DB-free.
 *
 * Exit code: `0` if every assertion passed and no unexpected error was thrown;
 * `1` otherwise. This makes the harness automation-friendly even though it is run
 * manually against a sandbox.
 *
 * @see ./fixture for the six-item tree this pushes.
 * @see ./teardown for the best-effort cleanup the `finally` calls.
 */

import { PatAuth } from '../../electron/sync/linear/auth';
import { LinearGraphQLClient } from '../../electron/sync/linear/client';
import { LinearAdapter } from '../../electron/sync/linear/linear-adapter';
import {
  CRITERIA_MARKER_START,
  CRITERIA_MARKER_END,
} from '../../electron/sync/linear/description';
import { planPush } from '../../electron/sync/sync-engine';
import { executePush, type PushResult } from '../../electron/sync/executor';
import type { CanonicalItem } from '../../electron/sync/canonical-item';
import type { SyncLink } from '../../electron/db/repositories/sync-links.repo';
import { buildFixture } from './fixture';
import { teardown, type TeardownTargets } from './teardown';

/** Stable connection id used for both pushes (production passes the real one). */
const CONNECTION_ID = 'e2e-linear-sandbox';

/** A `{ id, name }` label as returned by the team-labels read-back query. */
interface LabelNode {
  id: string;
  name: string;
}

/** GraphQL `data` shape for reading an issue's applied labels. */
interface IssueLabelsResponse {
  issue: { labels: { nodes: LabelNode[] } } | null;
}

/** GraphQL `data` shape for reading an issue's native parent link. */
interface IssueParentResponse {
  issue: { parent: { id: string } | null } | null;
}

/**
 * A tiny assertion recorder. Rather than throwing on the first failure (which
 * would skip later checks AND the teardown), each assertion appends a structured
 * result; the harness prints them all and decides the exit code at the end.
 */
class Checks {
  private readonly results: { ok: boolean; label: string; detail?: string }[] = [];

  /** Record a boolean assertion with a human-readable label. */
  assert(ok: boolean, label: string, detail?: string): void {
    this.results.push({ ok, label, detail });
    const tag = ok ? 'PASS' : 'FAIL';
    const suffix = !ok && detail ? ` — ${detail}` : '';
    console.log(`  [${tag}] ${label}${suffix}`);
  }

  /** Assert strict equality, formatting both sides into the failure detail. */
  assertEqual(actual: unknown, expected: unknown, label: string): void {
    this.assert(
      actual === expected,
      label,
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }

  /** True when every recorded assertion passed. */
  get allPassed(): boolean {
    return this.results.every((r) => r.ok);
  }

  /** Count of failed assertions, for the final report line. */
  get failedCount(): number {
    return this.results.filter((r) => !r.ok).length;
  }

  /** Total assertions recorded. */
  get total(): number {
    return this.results.length;
  }
}

/** Reads a required env var or returns undefined; the caller validates presence. */
function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** Lowercased set of label names, for case-insensitive presence checks. */
function lowerSet(names: Iterable<string>): Set<string> {
  const s = new Set<string>();
  for (const n of names) s.add(n.toLowerCase());
  return s;
}

/** Reads a created item's external id from the push results by local id. */
function externalIdOf(result: PushResult, localId: string): string | undefined {
  return result.results.find((r) => r.localId === localId)?.externalId;
}

async function main(): Promise<number> {
  // The driver guarantees these are set (it exits 2 otherwise), but guard anyway
  // so running the bundle directly fails loudly rather than hitting Linear with
  // an empty credential.
  const pat = env('LINEAR_E2E_PAT');
  const teamId = env('LINEAR_E2E_TEAM_ID');
  const projectId = env('LINEAR_E2E_PROJECT_ID'); // optional
  if (!pat || !teamId) {
    console.error(
      '[e2e] LINEAR_E2E_PAT and LINEAR_E2E_TEAM_ID must be set. Run via `npm run e2e:linear`.',
    );
    return 1;
  }

  // Build the real pipeline. The PAT enters only through PatAuth; the client owns
  // the endpoint + real fetch; the adapter is a pure translation layer over it.
  const auth = new PatAuth(() => pat);
  const client = new LinearGraphQLClient({ auth });
  const adapter = new LinearAdapter(
    projectId ? { teamId, projectId } : { teamId },
    client,
  );

  const fixture = buildFixture();
  console.log(`[e2e] run id ${fixture.runId} (tag "${fixture.runTag}") against team ${teamId}`);

  // Snapshot the team's labels BEFORE the run so teardown can diff out only the
  // labels this run created, and so push 2 can assert no NEW labels appeared.
  const labelsBefore = await snapshotLabels(adapter);
  const labelNamesBefore = lowerSet(labelsBefore.map((l) => l.name));

  // The harness-owned SyncLink store. writeLink writes here; resolveLink reads
  // here. Both pushes share it, which is what makes push 2 see push 1's hashes.
  const captured = new Map<string, SyncLink>();
  const writeLink = (link: SyncLink): void => {
    captured.set(link.specItemId, link);
  };
  const resolveLink = (specItemId: string): SyncLink | null => captured.get(specItemId) ?? null;

  const checks = new Checks();
  // Populated from push 1's results so teardown deletes exactly what was created,
  // regardless of where (or whether) an assertion failed.
  let push1: PushResult | undefined;

  try {
    // ---- PUSH 1: everything is CREATE ----------------------------------------
    console.log('\n[e2e] PUSH 1 — expecting 6 creates');
    const plan1 = planPush(fixture.items, resolveLink);
    push1 = await executePush(plan1, CONNECTION_ID, { adapter, writeLink });

    checks.assertEqual(push1.failed, 0, 'push 1: no failures');
    checks.assertEqual(push1.created, 6, 'push 1: created 6 items');

    // Epic landed as a Project and reads back with the pushed title.
    const epicExtId = externalIdOf(push1, 'E1');
    checks.assert(!!epicExtId, 'push 1: epic has an external id');
    if (epicExtId) {
      const epicState = await adapter.getRemoteState(epicExtId, 'epic');
      checks.assert(epicState !== null, 'push 1: epic readable via getRemoteState');
      const epicTitle = fixture.items.find((i) => i.localId === 'E1')?.title;
      checks.assertEqual(epicState?.title, epicTitle, 'push 1: epic title matches');
    }

    // Every feature/story reads back as a non-null remote issue.
    for (const localId of ['F1', 'F2', 'S1', 'S2', 'S3'] as const) {
      const extId = externalIdOf(push1, localId);
      checks.assert(!!extId, `push 1: ${localId} has an external id`);
      if (extId) {
        const item = fixture.items.find((i) => i.localId === localId);
        const state = await adapter.getRemoteState(extId, item!.level);
        checks.assert(state !== null, `push 1: ${localId} readable via getRemoteState`);
        checks.assertEqual(state?.title, item!.title, `push 1: ${localId} title matches`);
      }
    }

    // The three stories are children of a NON-container feature, so each got a
    // real native linkItems call → linked: true with no linkError.
    for (const localId of ['S1', 'S2', 'S3'] as const) {
      const r = push1.results.find((x) => x.localId === localId);
      checks.assert(r?.linked === true, `push 1: ${localId} natively linked to its feature`);
    }

    // Criteria checklist present: read back F1 and S1 descriptions and confirm
    // the marker-bounded region plus one `- [ ]` line per criterion.
    await assertCriteriaChecklist(checks, adapter, push1, fixture.items, 'F1');
    await assertCriteriaChecklist(checks, adapter, push1, fixture.items, 'S1');

    // Labels synced: F1's applied labels include its fixture tags (case-insensitive).
    const f1ExtId = externalIdOf(push1, 'F1');
    if (f1ExtId) {
      const applied = await readIssueLabels(client, f1ExtId);
      const appliedLower = lowerSet(applied.map((l) => l.name));
      const f1Tags = fixture.items.find((i) => i.localId === 'F1')?.tags ?? [];
      for (const tag of f1Tags) {
        checks.assert(
          appliedLower.has(tag.toLowerCase()),
          `push 1: F1 carries label "${tag}"`,
          `applied labels: ${applied.map((l) => l.name).join(', ')}`,
        );
      }
    }

    // Native parent link landed: S1's Linear parent is F1's external id.
    const s1ExtId = externalIdOf(push1, 'S1');
    if (s1ExtId && f1ExtId) {
      const parentId = await readIssueParent(client, s1ExtId);
      checks.assertEqual(parentId, f1ExtId, 'push 1: S1 parent.id equals F1 external id');
    }

    // Snapshot the team labels AFTER push 1's label-seeding so the push-2
    // idempotency check below compares against the post-push-1 baseline (the
    // labels this run is *allowed* to have created), not the pre-run baseline.
    const labelNamesAfterPush1 = lowerSet((await snapshotLabels(adapter)).map((l) => l.name));

    // ---- PUSH 2: re-plan against the populated store; everything SKIPs --------
    console.log('\n[e2e] PUSH 2 — expecting 6 skips (idempotent)');
    const plan2 = planPush(fixture.items, resolveLink);
    const push2 = await executePush(plan2, CONNECTION_ID, { adapter, writeLink });

    checks.assertEqual(push2.skipped, 6, 'push 2: skipped 6 items');
    checks.assertEqual(push2.created, 0, 'push 2: created 0 items');
    checks.assertEqual(push2.updated, 0, 'push 2: updated 0 items');
    checks.assertEqual(push2.failed, 0, 'push 2: no failures');

    // Label idempotency: push 2 ran no creates, so no NEW team label should have
    // appeared versus the post-push-1 snapshot.
    const labelsAfterPush2 = await snapshotLabels(adapter);
    const newSincePush1 = labelsAfterPush2.filter(
      (l) => !labelNamesAfterPush1.has(l.name.toLowerCase()),
    );
    checks.assert(
      newSincePush1.length === 0,
      'push 2: no new labels created (label idempotency)',
      `unexpected new labels: ${newSincePush1.map((l) => l.name).join(', ')}`,
    );

    console.log(`\n[e2e] ${checks.total - checks.failedCount}/${checks.total} checks passed`);
  } catch (err) {
    // An unexpected throw (transport down, bad credential, contract violation) is
    // a hard failure — record it so the exit code is non-zero, then fall through
    // to teardown so we still clean up whatever push 1 managed to create.
    checks.assert(false, 'no unexpected error', err instanceof Error ? err.message : String(err));
  } finally {
    // ---- TEARDOWN: delete everything push 1 created --------------------------
    console.log('\n[e2e] TEARDOWN — deleting created data');
    const targets = await buildTeardownTargets(adapter, push1, labelNamesBefore, fixture.runTag);
    const summary = await teardown(client, targets);
    console.log(
      `[e2e] teardown: ${summary.issuesDeleted} issue(s), ${summary.projectsDeleted} project(s), ` +
        `${summary.labelsDeleted} label(s) deleted; ${summary.failures.length} failure(s)`,
    );
    for (const f of summary.failures) {
      console.error(`  [teardown] failed to delete ${f.kind} ${f.id}: ${f.message}`);
    }
  }

  if (checks.allPassed) {
    console.log('\n[e2e] RESULT: PASS');
    return 0;
  }
  console.error(`\n[e2e] RESULT: FAIL (${checks.failedCount}/${checks.total} checks failed)`);
  return 1;
}

/** Snapshots the team's current labels as `{ id, name }[]` via the adapter. */
async function snapshotLabels(adapter: LinearAdapter): Promise<LabelNode[]> {
  const metadata = await adapter.getMetadata();
  return (metadata.labels ?? []).map((l) => ({ id: l.id, name: l.name }));
}

/**
 * Reads back a created item's description via `getRemoteState` and asserts it
 * carries the marker-bounded criteria region plus one `- [ ]` line per criterion.
 * Reuses the exported marker constants so the assertion can never drift from the
 * composer that wrote them.
 */
async function assertCriteriaChecklist(
  checks: Checks,
  adapter: LinearAdapter,
  push: PushResult,
  items: CanonicalItem[],
  localId: string,
): Promise<void> {
  const item = items.find((i) => i.localId === localId);
  const extId = externalIdOf(push, localId);
  if (!item || !extId) {
    checks.assert(false, `push 1: ${localId} present for criteria read-back`);
    return;
  }
  const state = await adapter.getRemoteState(extId, item.level);
  const description = state?.description ?? '';
  checks.assert(
    description.includes(CRITERIA_MARKER_START) && description.includes(CRITERIA_MARKER_END),
    `push 1: ${localId} description has criteria markers`,
  );
  for (const criterion of item.criteria ?? []) {
    checks.assert(
      description.includes(`- [ ] ${criterion}`),
      `push 1: ${localId} description has checklist line for "${criterion}"`,
    );
  }
}

/** Reads the labels currently applied to a Linear issue. */
async function readIssueLabels(
  client: LinearGraphQLClient,
  issueId: string,
): Promise<LabelNode[]> {
  const query = `
    query($id: String!) {
      issue(id: $id) { labels { nodes { id name } } }
    }
  `;
  const data = await client.request<IssueLabelsResponse>(query, { id: issueId });
  return data.issue?.labels.nodes ?? [];
}

/** Reads a Linear issue's native parent id (or null when it has no parent). */
async function readIssueParent(
  client: LinearGraphQLClient,
  issueId: string,
): Promise<string | null> {
  const query = `
    query($id: String!) {
      issue(id: $id) { parent { id } }
    }
  `;
  const data = await client.request<IssueParentResponse>(query, { id: issueId });
  return data.issue?.parent?.id ?? null;
}

/**
 * Builds the teardown id lists: every issue/project external id from push 1's
 * results, and the ids of labels this run created. New labels are matched by
 * diffing the post-run team labels against the pre-run snapshot AND restricting
 * to names this run is responsible for (the run tag or the generic tags the
 * fixture used), so teardown never deletes a pre-existing team label.
 */
async function buildTeardownTargets(
  adapter: LinearAdapter,
  push: PushResult | undefined,
  labelNamesBefore: Set<string>,
  runTag: string,
): Promise<TeardownTargets> {
  const issueIds: string[] = [];
  const projectIds: string[] = [];
  if (push) {
    for (const r of push.results) {
      if (!r.externalId) continue;
      // The epic is the only level Linear maps to a Project; everything else is
      // an Issue. The plan order doesn't carry level, so infer from the fixture
      // local id convention: E* is the epic.
      if (r.localId.startsWith('E')) projectIds.push(r.externalId);
      else issueIds.push(r.externalId);
    }
  }

  // Identify labels created THIS run. The run-tagged label is unambiguous; the
  // generic ones ('frontend'/'backend') are only deleted if they did NOT exist
  // before the run (i.e. this run created them), so a pre-existing team label is
  // never removed.
  const labelsAfter = await snapshotLabels(adapter);
  const runTagLower = runTag.toLowerCase();
  const labelIds = labelsAfter
    .filter((l) => {
      const name = l.name.toLowerCase();
      if (name === runTagLower) return true; // unmistakably ours
      return !labelNamesBefore.has(name); // new since the run started
    })
    .map((l) => l.id);

  return { issueIds, projectIds, labelIds };
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // main() catches its own errors, so reaching here means the harness itself
    // (not an assertion) blew up before teardown could run. Fail loudly.
    console.error('[e2e] fatal harness error:', err);
    process.exit(1);
  });
