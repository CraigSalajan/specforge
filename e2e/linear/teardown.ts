/**
 * Best-effort teardown for the live Linear E2E harness (TER-25).
 *
 * Every E2E run CREATES real data in a Linear workspace — Projects (from epics),
 * Issues (from features/stories), and Labels (from item tags). This module
 * deletes that data after the assertions run, so the sandbox does not accumulate
 * orphans across runs. It is the cleanup half of the harness's `try/finally`.
 *
 * ## Why it never throws
 * Teardown runs in the `finally` of the harness, AFTER the pass/fail verdict is
 * decided. If a single delete failed and threw, it would mask the real test
 * result (an assertion failure could surface as a teardown error, or a genuine
 * pass could be reported as a crash). So every mutation is wrapped: per-id errors
 * are caught and collected into a {@link TeardownSummary}, and the function
 * always resolves. The operator reads the summary to spot anything that leaked
 * and needs manual cleanup.
 *
 * ## Deletion order
 * Issues first, then Projects, then Labels. Issues belong to a Project, so
 * deleting children before their container avoids touching an issue whose project
 * was already removed; labels are independent and go last. None of these deletes
 * depends on another succeeding — each id is attempted regardless of earlier
 * outcomes — but the order keeps the sequence intuitive and minimizes
 * already-gone "not found" noise.
 *
 * The module owns no transport: it talks to Linear exclusively through the
 * injected {@link LinearGraphQLClient}, exactly like the adapter. It reaches for
 * no Electron API and no DB.
 *
 * @see ./run for the harness that builds the ids and calls this in `finally`.
 */

import type { LinearGraphQLClient } from '../../electron/sync/linear/client';

/** The provider ids created during a run, grouped by kind, for deletion. */
export interface TeardownTargets {
  /** External ids of Issues created from features/stories. */
  issueIds: string[];
  /** External ids of Projects created from epics. */
  projectIds: string[];
  /** External ids of Labels created from item tags this run. */
  labelIds: string[];
}

/** A single failed delete, captured rather than thrown. */
export interface TeardownFailure {
  /** Which kind of object the delete targeted. */
  kind: 'issue' | 'project' | 'label';
  /** The provider id that failed to delete. */
  id: string;
  /** The error message (never the raw error object). */
  message: string;
}

/** Outcome of a teardown pass: how many of each kind were deleted, plus failures. */
export interface TeardownSummary {
  /** Count of issues successfully deleted (`success: true`). */
  issuesDeleted: number;
  /** Count of projects successfully deleted. */
  projectsDeleted: number;
  /** Count of labels successfully deleted. */
  labelsDeleted: number;
  /** Every delete that errored or returned `success: false`, with its message. */
  failures: TeardownFailure[];
}

/** GraphQL `data` shape for the `issueDelete` mutation. */
interface IssueDeleteResponse {
  issueDelete: { success: boolean };
}

/** GraphQL `data` shape for the `projectDelete` mutation. */
interface ProjectDeleteResponse {
  projectDelete: { success: boolean };
}

/** GraphQL `data` shape for the `issueLabelDelete` mutation. */
interface LabelDeleteResponse {
  issueLabelDelete: { success: boolean };
}

const ISSUE_DELETE = `
  mutation($id: String!) {
    issueDelete(id: $id) { success }
  }
`;

const PROJECT_DELETE = `
  mutation($id: String!) {
    projectDelete(id: $id) { success }
  }
`;

const LABEL_DELETE = `
  mutation($id: String!) {
    issueLabelDelete(id: $id) { success }
  }
`;

/**
 * Deletes every created object, best-effort, and returns a summary.
 *
 * Issues are deleted first, then projects, then labels (see the module docblock).
 * Each id is attempted independently: a delete that throws, or that returns
 * `success: false`, is recorded as a {@link TeardownFailure} and the pass
 * continues. The returned promise always resolves — teardown never throws.
 *
 * @param client the injected GraphQL transport carrying the credential.
 * @param targets the issue/project/label ids created during the run.
 * @returns counts of what was deleted and the list of any failures.
 */
export async function teardown(
  client: LinearGraphQLClient,
  targets: TeardownTargets,
): Promise<TeardownSummary> {
  const summary: TeardownSummary = {
    issuesDeleted: 0,
    projectsDeleted: 0,
    labelsDeleted: 0,
    failures: [],
  };

  // Issues before their containing projects, then labels (independent) last.
  for (const id of targets.issueIds) {
    try {
      const data = await client.request<IssueDeleteResponse>(ISSUE_DELETE, { id });
      if (data.issueDelete?.success) summary.issuesDeleted += 1;
      else summary.failures.push({ kind: 'issue', id, message: 'issueDelete returned success: false' });
    } catch (err) {
      summary.failures.push({ kind: 'issue', id, message: errorMessage(err) });
    }
  }

  for (const id of targets.projectIds) {
    try {
      const data = await client.request<ProjectDeleteResponse>(PROJECT_DELETE, { id });
      if (data.projectDelete?.success) summary.projectsDeleted += 1;
      else
        summary.failures.push({
          kind: 'project',
          id,
          message: 'projectDelete returned success: false',
        });
    } catch (err) {
      summary.failures.push({ kind: 'project', id, message: errorMessage(err) });
    }
  }

  for (const id of targets.labelIds) {
    try {
      const data = await client.request<LabelDeleteResponse>(LABEL_DELETE, { id });
      if (data.issueLabelDelete?.success) summary.labelsDeleted += 1;
      else
        summary.failures.push({
          kind: 'label',
          id,
          message: 'issueLabelDelete returned success: false',
        });
    } catch (err) {
      summary.failures.push({ kind: 'label', id, message: errorMessage(err) });
    }
  }

  return summary;
}

/** Normalizes an unknown thrown value to a string message. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
