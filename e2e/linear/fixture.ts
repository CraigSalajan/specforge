/**
 * Canonical-item fixture for the live Linear E2E harness (TER-25).
 *
 * Builds the small, deterministic spec tree the harness pushes TWICE against a
 * real Linear sandbox. It is intentionally minimal but exercises BOTH parent-link
 * paths the executor distinguishes:
 *
 *   - **Container membership** (epic → feature). Linear maps an `epic` to a
 *     Project; a `feature` whose parent IS that epic joins the project via
 *     `projectId` at create time. The executor therefore marks the feature
 *     `linked: true` *without* calling `linkItems` (the parent IS the container).
 *   - **Native parent link** (feature → story). A `feature` is NOT a Linear
 *     container, so a `story` under it gets a real `issueUpdate(parentId)` call —
 *     the path that lands a native Linear sub-issue relationship.
 *
 * Six items total: one epic (E1), two features under it (F1, F2), and three
 * stories — two under F1 (S1, S2) and one under F2 (S3).
 *
 * ## Why a per-run id and a per-run tag
 * The harness creates and then deletes real data in a shared workspace, and runs
 * may overlap or leave orphans if teardown is interrupted. Every run therefore
 * bakes a unique id into each title and threads a unique tag through the items'
 * `tags`, so (a) a human can spot this run's artifacts in the Linear UI, and (b)
 * teardown can match THIS run's freshly-created labels by name and avoid deleting
 * a pre-existing team label that merely shares a generic name like `frontend`.
 *
 * Because this is a plain Node script (never bundled into the renderer and never
 * unit-tested), non-determinism is fine and intended here: `Date.now()` +
 * `Math.random()` produce the unique run id. This is the one module in the
 * harness where that is appropriate.
 *
 * The module is pure: it builds and returns data, performs no I/O, and reaches
 * for no network or Electron API.
 */

import type { CanonicalItem } from '../../electron/sync/canonical-item';

/** A built fixture: the items to push plus the run id and tag baked into them. */
export interface E2eFixture {
  /** Unique id for this run, embedded in every title (e.g. `e2e-l3k9-x7q2`). */
  readonly runId: string;
  /**
   * Unique tag threaded through tagged items' `tags`. Every label Linear creates
   * for this run carries this name, so teardown can match this run's labels
   * without touching a pre-existing generic team label.
   */
  readonly runTag: string;
  /** The six canonical items, ready to feed {@link planPush}. */
  readonly items: CanonicalItem[];
}

/**
 * Generates a short, reasonably-unique run token from the clock + a random
 * suffix. Base-36 keeps it compact and label-safe (alphanumerics only); the two
 * independent sources make a collision between concurrent runs vanishingly
 * unlikely without needing a UUID dependency.
 */
function generateRunId(): string {
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `e2e-${time}-${rand}`;
}

/**
 * Builds the canonical-item fixture for one E2E run.
 *
 * @returns the run id, run tag, and the six {@link CanonicalItem}s — with the run
 * id woven into each title and the run tag woven into tagged items so the run's
 * artifacts are identifiable and reliably matchable at teardown.
 */
export function buildFixture(): E2eFixture {
  const runId = generateRunId();
  const runTag = `${runId}-tag`;

  // Epic → Linear Project. Carries a description so the project's body is written
  // and can be read back via getRemoteState('epic').
  const epic: CanonicalItem = {
    localId: 'E1',
    level: 'epic',
    title: `[${runId}] Checkout revamp (epic)`,
    description: 'End-to-end checkout overhaul tracked as a Linear project.',
  };

  // Feature under the epic, WITH criteria + tags. Its parent is the epic, so it
  // joins the epic's project via projectId (container membership) — the executor
  // marks it linked with no native linkItems call. The criteria fold into the
  // issue description as a `- [ ]` checklist that the harness reads back.
  const featureF1: CanonicalItem = {
    localId: 'F1',
    level: 'feature',
    parentLocalId: 'E1',
    title: `[${runId}] One-page checkout (feature)`,
    description: 'Collapse the multi-step checkout into a single page.',
    criteria: [
      'User can complete checkout without leaving the page',
      'Form validation errors surface inline',
    ],
    tags: [runTag, 'frontend'],
  };

  // Second feature under the epic, tagged but criteria-less. Confirms a second
  // container-membership child and a second tagged label path.
  const featureF2: CanonicalItem = {
    localId: 'F2',
    level: 'feature',
    parentLocalId: 'E1',
    title: `[${runId}] Payment gateway integration (feature)`,
    description: 'Integrate the new payment gateway behind a feature flag.',
    tags: [runTag, 'backend'],
  };

  // Story under F1, WITH criteria + tag. Its parent is a feature (NOT a
  // container), so it gets a real native parent link via linkItems — the harness
  // asserts the landed Linear `parent.id` equals F1's external id.
  const storyS1: CanonicalItem = {
    localId: 'S1',
    level: 'story',
    parentLocalId: 'F1',
    title: `[${runId}] Render single-page checkout form (story)`,
    description: 'Compose the address, shipping, and payment sections on one page.',
    criteria: [
      'All three sections render on first paint',
      'Section state persists across validation errors',
    ],
    tags: [runTag],
  };

  // Second story under F1, no criteria/tags. A second feature→story native link.
  const storyS2: CanonicalItem = {
    localId: 'S2',
    level: 'story',
    parentLocalId: 'F1',
    title: `[${runId}] Persist checkout draft locally (story)`,
    description: 'Save in-progress checkout to local storage between reloads.',
  };

  // Story under F2 — a native link to the OTHER feature, so both features own a
  // linked child and the inherited-project path is exercised down two branches.
  const storyS3: CanonicalItem = {
    localId: 'S3',
    level: 'story',
    parentLocalId: 'F2',
    title: `[${runId}] Tokenize card details (story)`,
    description: 'Exchange raw card input for a gateway token before submit.',
  };

  return {
    runId,
    runTag,
    items: [epic, featureF1, featureF2, storyS1, storyS2, storyS3],
  };
}
