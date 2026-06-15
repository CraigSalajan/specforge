/**
 * Linear adapter — skeleton (TER-14).
 *
 * The concrete {@link IAdapter} for Linear: the translation layer that turns a
 * provider-agnostic {@link CanonicalItem} into Linear-native GraphQL work (a
 * Project / Story / Sub-issue per `./level-mapping`). It owns no transport of
 * its own — every call goes through the injected {@link LinearGraphQLClient},
 * which already encapsulates the endpoint, auth header, retries, and rate-limit
 * handling. This keeps the adapter a pure translation concern and lets tests
 * drive it with a fake client (no network, no DB).
 *
 * ## Implementation status
 * `getMetadata` (TER-16), `createItem` (TER-17), and `updateItem` (TER-18) are
 * implemented: the first queries the configured team's workflow states and labels
 * (and the optional project) and returns a normalized {@link ProjectMetadata}; the
 * second creates a Linear issue from a {@link CanonicalItem} and returns its
 * external id/url; the third pushes title/description changes to an existing issue
 * via `issueUpdate`. The remaining {@link IAdapter} operation is still stubbed and
 * throws a clear "not implemented yet" error tagged with the ticket that fills it
 * in: `linkItems` (TER-20).
 *
 * ## Why the token is not in the config
 * {@link LinearConnectionConfig} carries only the *where* (team/project target),
 * never the *who* (the credential). The auth token enters exclusively through
 * the injected {@link LinearGraphQLClient}, which alone knows the PAT-vs-OAuth
 * header shape (see `./auth`), so the adapter never handles a raw secret.
 *
 * @see ../adapter for the provider-agnostic {@link IAdapter} contract.
 * @see ./client for the {@link LinearGraphQLClient} transport this wraps.
 */

import type {
  AdapterName,
  ExternalItemResult,
  IAdapter,
  LabelInfo,
  ProjectMetadata,
  WorkflowStateInfo,
} from '../adapter';
import type { CanonicalItem, CanonicalLevel } from '../canonical-item';
import type { LinearGraphQLClient } from './client';
import { LinearRequestError } from './errors';

/**
 * The Linear workspace target an adapter writes into. Identifies *where* items
 * are created — the team that owns the issues, and optionally the project to
 * group them under. The auth credential is deliberately absent: it arrives via
 * the injected {@link LinearGraphQLClient}, not through this config.
 */
export interface LinearConnectionConfig {
  /** Linear team id that owns the created issues. */
  teamId: string;
  /** Optional Linear project id to group created issues under. */
  projectId?: string;
  /** Optional Linear label id applied to created Features (level === 'feature'). */
  featureLabelId?: string;
}

/** All canonical levels Linear can represent (see `../level-mapping`). */
const LINEAR_SUPPORTED_LEVELS: CanonicalLevel[] = [
  'epic',
  'feature',
  'story',
  'criterion',
];

/** A workflow-state node as selected from `team.states`. */
interface StateNode {
  id: string;
  name: string;
  type: string;
  position?: number;
  color?: string;
}

/** A label node as selected from `team.labels`. */
interface LabelNode {
  id: string;
  name: string;
  color?: string;
  isGroup?: boolean;
  parent?: { id: string } | null;
}

/** Shape of the `LinearProjectMetadata` query's `data` payload. */
interface MetadataResponse {
  team: {
    id: string;
    name: string;
    states: { nodes: StateNode[] };
    labels: { nodes: LabelNode[] };
  } | null;
  project?: { id: string; name: string; url: string } | null;
}

/** Shape of the `issueCreate` mutation's `data` payload. */
interface CreateIssueResponse {
  issueCreate: {
    success: boolean;
    issue: { id: string; url: string } | null;
  };
}

/** Shape of the `issueUpdate` mutation's `data` payload. */
interface UpdateIssueResponse {
  issueUpdate: {
    success: boolean;
    issue: { id: string; url: string } | null;
  };
}

/**
 * Linear {@link IAdapter}. Holds the connection target and the injected
 * transport. `getMetadata`, `createItem`, and `updateItem` are implemented;
 * `linkItems` remains a stub awaiting its follow-up ticket.
 */
export class LinearAdapter implements IAdapter {
  /** Which provider this adapter targets. */
  readonly name: AdapterName = 'linear';

  /**
   * @param config the team/project target this adapter writes into; readable by
   * the Sync Engine and tests.
   * @param client the injected GraphQL transport carrying the credential,
   * retries, and rate-limit handling.
   */
  constructor(
    readonly config: LinearConnectionConfig,
    private readonly client: LinearGraphQLClient,
  ) {}

  /**
   * @inheritdoc
   *
   * Queries the configured team's workflow states and labels (and the optional
   * project), then normalizes the result into provider-agnostic
   * {@link ProjectMetadata}. An `auth` failure is re-thrown with team context so
   * callers see which token/team to fix; all other failures propagate unchanged.
   */
  async getMetadata(): Promise<ProjectMetadata> {
    const { query, variables } = this.buildMetadataQuery();

    let data: MetadataResponse;
    try {
      data = await this.client.request<MetadataResponse>(query, variables);
    } catch (err) {
      if (err instanceof LinearRequestError && err.info.code === 'auth') {
        throw new LinearRequestError({
          ...err.info,
          message: `Linear metadata fetch failed for team ${this.config.teamId}: ${err.info.message}. Check that the configured token has read access to this team.`,
        });
      }
      throw err;
    }

    const team = data.team;
    if (!team) {
      throw new LinearRequestError({
        code: 'bad_request',
        retryable: false,
        message: `Linear team ${this.config.teamId} was not found or is not visible to the configured token.`,
      });
    }

    const project = data.project ?? undefined;

    const workflowStates: WorkflowStateInfo[] = team.states.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      position: node.position,
      color: node.color,
    }));

    const labels: LabelInfo[] = team.labels.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      color: node.color,
      isGroup: node.isGroup,
      parentId: node.parent?.id,
    }));

    return {
      provider: 'linear',
      projectId: this.config.projectId ?? team.id,
      projectName: project?.name ?? team.name,
      url: project?.url,
      supportedLevels: LINEAR_SUPPORTED_LEVELS,
      workflowStates,
      labels,
    };
  }

  /**
   * Builds the metadata GraphQL document and its variables. The project
   * selection (and its `$projectId` variable) is included only when the config
   * targets a project, so the team-only path neither names nor passes a project.
   */
  private buildMetadataQuery(): {
    query: string;
    variables: Record<string, unknown>;
  } {
    const { teamId, projectId } = this.config;
    const hasProject = projectId !== undefined;

    const query = `
      query LinearProjectMetadata($teamId: String!${hasProject ? ', $projectId: String!' : ''}) {
        team(id: $teamId) {
          id
          name
          states(first: 250) { nodes { id name type position color } }
          labels(first: 250) { nodes { id name color isGroup parent { id } } }
        }${hasProject ? '\n        project(id: $projectId) { id name url }' : ''}
      }
    `;

    const variables: Record<string, unknown> = { teamId };
    if (hasProject) variables['projectId'] = projectId;

    return { query, variables };
  }

  /**
   * @inheritdoc
   *
   * Maps a {@link CanonicalItem} onto Linear's `issueCreate` mutation: the title
   * and (when present) description become the issue's fields, the configured team
   * always targets the new issue, the configured project is attached when set,
   * and the configured `featureLabelId` is applied only to `feature`-level items.
   * An `auth` failure is re-thrown with team context so callers see which
   * token/team lacks write access; all other failures propagate unchanged. A
   * soft failure (Linear returns `success: false`, a null issue, or an issue
   * missing its id/url) is surfaced as a non-retryable `bad_request` naming the
   * item so the failure is diagnosable rather than persisted as a broken link.
   * Parent linkage is deferred to TER-18.
   */
  async createItem(item: CanonicalItem): Promise<ExternalItemResult> {
    const { query, variables } = this.buildCreateIssueMutation(item);

    let data: CreateIssueResponse;
    try {
      data = await this.client.request<CreateIssueResponse>(query, variables);
    } catch (err) {
      if (err instanceof LinearRequestError && err.info.code === 'auth') {
        throw new LinearRequestError({
          ...err.info,
          message: `Linear issue creation failed for team ${this.config.teamId}: ${err.info.message}. Check that the configured token has write access to this team.`,
        });
      }
      throw err;
    }

    // A soft failure (`success: false` / null issue) and a malformed success
    // (an issue missing its id or url) are both treated as a non-retryable
    // `bad_request`: returning an `ExternalItemResult` with an empty/undefined
    // id or url would let the engine persist a SyncLink that can never address
    // the created issue, silently breaking idempotency.
    const issue = data.issueCreate?.issue;
    if (!data.issueCreate?.success || !issue || !issue.id || !issue.url) {
      throw new LinearRequestError({
        code: 'bad_request',
        retryable: false,
        message: `Linear rejected creation of ${item.level} "${item.title}" for team ${this.config.teamId}.`,
      });
    }

    return { externalId: issue.id, externalUrl: issue.url };
  }

  /**
   * Builds the `issueCreate` mutation and its single `$input` variable. The
   * input object is composed in TypeScript so optional fields appear only when
   * present: `description` only when defined, `projectId` only when the config
   * targets a project, and `labelIds` only for `feature`-level items when a
   * `featureLabelId` is configured. The team always targets the new issue.
   */
  private buildCreateIssueMutation(item: CanonicalItem): {
    query: string;
    variables: Record<string, unknown>;
  } {
    const query = `
      mutation LinearCreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id url }
        }
      }
    `;

    const input: Record<string, unknown> = {
      title: item.title,
      teamId: this.config.teamId,
    };
    if (item.description !== undefined) input['description'] = item.description;
    if (this.config.projectId !== undefined) input['projectId'] = this.config.projectId;
    if (item.level === 'feature' && this.config.featureLabelId !== undefined) {
      input['labelIds'] = [this.config.featureLabelId];
    }

    return { query, variables: { input } };
  }

  /**
   * @inheritdoc
   *
   * Pushes the managed fields of a {@link CanonicalItem} onto Linear's
   * `issueUpdate` mutation: the title and (when present) description overwrite the
   * existing issue's fields, with the issue targeted by the top-level `id` rather
   * than by team. An `auth` failure is re-thrown with team context so callers see
   * which token/team lacks write access; all other failures propagate unchanged. A
   * soft failure (Linear returns `success: false`) is surfaced as a non-retryable
   * `bad_request` naming the issue and item so the failure is diagnosable.
   *
   * Material-change gating is the engine's responsibility, not this method's: the
   * executor diffs unchanged items as `skip` and never calls `updateItem` for them
   * (see `electron/sync/executor.ts`), so when invoked this method always pushes
   * the current managed fields. It resolves to `void` — the executor refreshes the
   * SyncLink hash/timestamp on resolve and records `failed` on throw.
   */
  async updateItem(id: string, item: CanonicalItem): Promise<void> {
    const { query, variables } = this.buildUpdateIssueMutation(id, item);

    let data: UpdateIssueResponse;
    try {
      data = await this.client.request<UpdateIssueResponse>(query, variables);
    } catch (err) {
      if (err instanceof LinearRequestError && err.info.code === 'auth') {
        throw new LinearRequestError({
          ...err.info,
          message: `Linear issue update failed for team ${this.config.teamId}: ${err.info.message}. Check that the configured token has write access to this team.`,
        });
      }
      throw err;
    }

    // A soft failure (`success: false`) is surfaced as a non-retryable
    // `bad_request`: resolving anyway would let the engine refresh the SyncLink
    // hash/timestamp as if the change had landed, masking the rejection.
    if (!data.issueUpdate?.success) {
      throw new LinearRequestError({
        code: 'bad_request',
        retryable: false,
        message: `Linear rejected update of issue ${id} (${item.level} "${item.title}") for team ${this.config.teamId}.`,
      });
    }

    return;
  }

  /**
   * Builds the `issueUpdate` mutation and its `$id` / `$input` variables. The
   * issue is targeted by the top-level `id`, so the input never carries `teamId`
   * (it is not part of `IssueUpdateInput`). The title is always set; `description`
   * is composed in only when defined. Title and description are the full scope of
   * TER-18 — projectId/labelIds are intentionally not touched here.
   */
  private buildUpdateIssueMutation(
    id: string,
    item: CanonicalItem,
  ): {
    query: string;
    variables: Record<string, unknown>;
  } {
    const query = `
      mutation LinearUpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { id url }
        }
      }
    `;

    const input: Record<string, unknown> = {
      title: item.title,
    };
    if (item.description !== undefined) input['description'] = item.description;

    return { query, variables: { id, input } };
  }

  /** @inheritdoc */
  async linkItems(parentId: string, childIds: string[]): Promise<void> {
    throw new Error('LinearAdapter.linkItems not implemented yet (TER-20)');
  }
}
