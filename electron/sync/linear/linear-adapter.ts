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
 * `getMetadata` (TER-16) is implemented: it queries the configured team's
 * workflow states and labels (and the optional project) and returns a normalized
 * {@link ProjectMetadata}. The remaining {@link IAdapter} operations are still
 * stubbed and throw a clear "not implemented yet" error tagged with the ticket
 * that fills them in: `createItem` (TER-17), `updateItem` (TER-18), and
 * `linkItems` (TER-20).
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

/**
 * Linear {@link IAdapter}. Holds the connection target and the injected
 * transport. `getMetadata` is implemented; the write operations remain stubs
 * awaiting their follow-up tickets.
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

  /** @inheritdoc */
  async createItem(item: CanonicalItem): Promise<ExternalItemResult> {
    throw new Error('LinearAdapter.createItem not implemented yet (TER-17)');
  }

  /** @inheritdoc */
  async updateItem(id: string, item: CanonicalItem): Promise<void> {
    throw new Error('LinearAdapter.updateItem not implemented yet (TER-18)');
  }

  /** @inheritdoc */
  async linkItems(parentId: string, childIds: string[]): Promise<void> {
    throw new Error('LinearAdapter.linkItems not implemented yet (TER-20)');
  }
}
