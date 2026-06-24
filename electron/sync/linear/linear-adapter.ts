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
 * All {@link IAdapter} operations are implemented: `getMetadata` (TER-16) queries
 * the configured team's workflow states and labels (and the optional project) and
 * returns a normalized {@link ProjectMetadata}; `createItem` (TER-17) creates a
 * Linear issue from a {@link CanonicalItem} and returns its external id/url;
 * `updateItem` (TER-18) pushes title/description changes to an existing issue via
 * `issueUpdate`; and `linkItems` (TER-19) sets each child issue's `parent` field
 * via `issueUpdate`.
 *
 * ## Epic → Project mapping (TER-20)
 * Linear maps `epic → Project` and `feature/story → Issue`. An `epic`-level
 * create/update therefore targets a Linear *project*, not an issue: `createItem`
 * delegates to `projectCreate` and `updateItem` to `projectUpdate`. Descendant
 * Features/Stories are associated with that project by setting each issue's
 * `projectId` at create time — Linear does not reliably inherit a parent's
 * project, so the engine resolves the owning project from the nearest Epic
 * ancestor and threads its external id into `createItem` via the
 * {@link CreateItemContext}; that resolved id (falling back to the static
 * `config.projectId`) becomes the issue's `projectId`.
 *
 * ## Label syncing (TER-22)
 * An item's free-form `tags` (label *names*) are synced to Linear labels at
 * *create time only* (deliberately not on update, which would clobber labels a
 * user added by hand): existing labels are reused and any that don't exist are
 * created (create-if-missing), then the resolved ids are applied to the new
 * issue. Matching is case-insensitive/trimmed (see `./labels`). To avoid
 * creating the same label twice across one push, the adapter holds a
 * `labelIdByName` index for its lifetime — seeded once (lazily, only when an
 * item actually has tags) from `getMetadata().labels` and extended on each
 * successful create. Epics are untouched (they map to Projects); label syncing
 * applies only to the issue path.
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
  CreateItemContext,
  ExternalItemResult,
  IAdapter,
  LabelInfo,
  ProjectMetadata,
  WorkflowStateInfo,
} from '../adapter';
import type { CanonicalItem, CanonicalLevel } from '../canonical-item';
import type { LinearGraphQLClient } from './client';
import { LinearRequestError } from './errors';
import { dedupeTags, normalizeLabelName } from './labels';

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

/** Shape of the `projectCreate` mutation's `data` payload. */
interface CreateProjectResponse {
  projectCreate: {
    success: boolean;
    project: { id: string; url: string } | null;
  };
}

/** Shape of the `projectUpdate` mutation's `data` payload. */
interface UpdateProjectResponse {
  projectUpdate: {
    success: boolean;
    project: { id: string; url: string } | null;
  };
}

/** Shape of the `issueLabelCreate` mutation's `data` payload. */
interface CreateLabelResponse {
  issueLabelCreate: {
    success: boolean;
    issueLabel: { id: string; name: string } | null;
  };
}

/**
 * Linear {@link IAdapter}. Holds the connection target and the injected
 * transport. All four operations — `getMetadata`, `createItem`, `updateItem`,
 * and `linkItems` — are implemented.
 */
export class LinearAdapter implements IAdapter {
  /** Which provider this adapter targets. */
  readonly name: AdapterName = 'linear';

  /**
   * Normalized-label-name → Linear label id index for label syncing (TER-22).
   * Scoped to this adapter instance — the single push — so the same new label
   * is created at most once even across multiple `createItem` calls. Seeded once
   * from `getMetadata().labels` (see {@link ensureLabelIndex}) and extended on
   * each successful {@link createLabel}.
   */
  private readonly labelIdByName = new Map<string, string>();

  /**
   * Memoizes the one-time label-index seed so `getMetadata` runs at most once per
   * push. Unset until the first item with tags triggers {@link ensureLabelIndex};
   * thereafter every caller awaits the same in-flight/settled promise.
   */
  private labelIndexPromise?: Promise<void>;

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
   * Routes by level. An `epic` is a Linear *Project*, so it delegates to
   * {@link createProjectFromEpic} (`projectCreate`). Every other level is a Linear
   * issue, mapped onto `issueCreate`: the title and (when present) description
   * become the issue's fields, the configured team always targets the new issue,
   * and the configured `featureLabelId` is applied only to `feature`-level items.
   * The issue's `projectId` is the project the engine resolved for the item's
   * nearest Epic ancestor (`context.projectExternalId`), falling back to the
   * static `config.projectId`; this is how Features/Stories join their Epic's
   * project, since Linear does not reliably inherit a parent's project. An `auth`
   * failure is re-thrown with team context so callers see which token/team lacks
   * write access; all other failures propagate unchanged. A soft failure (Linear
   * returns `success: false`, a null issue, or an issue missing its id/url) is
   * surfaced as a non-retryable `bad_request` naming the item so the failure is
   * diagnosable rather than persisted as a broken link. Parent linkage is handled
   * separately by `linkItems` (TER-19).
   */
  async createItem(
    item: CanonicalItem,
    context?: CreateItemContext,
  ): Promise<ExternalItemResult> {
    // An epic maps to a Linear Project, not an issue.
    if (item.level === 'epic') return this.createProjectFromEpic(item);

    // Features/Stories join their Epic's project via the engine-resolved
    // container id, falling back to the static config target when unset.
    const projectId = context?.projectExternalId ?? this.config.projectId;
    // Resolve the item's tags to Linear label ids (create-if-missing). Lazy:
    // a tag-less item resolves to `[]` without ever calling getMetadata.
    const tagLabelIds = await this.resolveLabelIds(item.tags ?? []);
    const { query, variables } = this.buildCreateIssueMutation(item, projectId, tagLabelIds);

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
   * present: `description` only when defined, `projectId` only when the caller
   * resolved one (the Epic's project, or the config fallback), and `labelIds`
   * only when the resolved label set is non-empty. The team always targets the
   * new issue.
   *
   * `labelIds` is the de-duped union of the tag-resolved ids (`tagLabelIds`,
   * TER-22) and the configured `featureLabelId` for `feature`-level items —
   * merged rather than overwritten so a feature's configured label survives
   * alongside its synced tag labels. The union preserves first-seen order
   * (tag ids first) and drops duplicates so a tag that resolves to the feature
   * label isn't applied twice.
   */
  private buildCreateIssueMutation(
    item: CanonicalItem,
    projectId?: string,
    tagLabelIds: string[] = [],
  ): {
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
    if (projectId !== undefined) input['projectId'] = projectId;

    // Union the synced tag labels with the configured feature label (feature
    // level only), de-duped and order-preserving; set `labelIds` only when it
    // would carry at least one id so the team-only/tag-less path stays clean.
    const featureLabelIds =
      item.level === 'feature' && this.config.featureLabelId !== undefined
        ? [this.config.featureLabelId]
        : [];
    const labelIds = [...new Set([...tagLabelIds, ...featureLabelIds])];
    if (labelIds.length > 0) input['labelIds'] = labelIds;

    return { query, variables: { input } };
  }

  /**
   * Resolves a list of free-form tag names to Linear label ids, creating any
   * that don't already exist (create-if-missing — TER-22). The input is de-duped
   * by normalized key first; an empty (or fully empty/whitespace) list resolves
   * to `[]` *without* seeding the index, so a tag-less item never triggers a
   * `getMetadata` round-trip. Otherwise the index is seeded once, then each tag
   * is looked up by its normalized key; a miss creates the label (original
   * casing) and caches the new id. The returned ids preserve the de-duped tag
   * order.
   *
   * @param tags the item's free-form tag names (label names, not ids).
   * @returns the resolved Linear label ids, in de-duped tag order.
   */
  private async resolveLabelIds(tags: string[]): Promise<string[]> {
    const unique = dedupeTags(tags);
    if (unique.length === 0) return [];

    await this.ensureLabelIndex();

    const ids: string[] = [];
    for (const tag of unique) {
      // `createLabel` caches the new id under the normalized key, so the lookup
      // hits on a later tag/item with the same key — no second create needed.
      const id =
        this.labelIdByName.get(normalizeLabelName(tag)) ?? (await this.createLabel(tag));
      ids.push(id);
    }
    return ids;
  }

  /**
   * Seeds the {@link labelIdByName} index from the team's existing labels, at
   * most once per adapter instance. The first caller assigns
   * {@link labelIndexPromise} to a `getMetadata`-backed seed routine; every later
   * caller awaits that same promise, so the team metadata is fetched once per
   * push no matter how many items have tags. Label *groups* (`isGroup: true`) are
   * skipped — they are containers, not labels an issue can carry — and each
   * applicable label is indexed under its normalized name.
   */
  private ensureLabelIndex(): Promise<void> {
    if (this.labelIndexPromise === undefined) {
      this.labelIndexPromise = (async () => {
        const metadata = await this.getMetadata();
        for (const label of metadata.labels ?? []) {
          if (label.isGroup) continue;
          this.labelIdByName.set(normalizeLabelName(label.name), label.id);
        }
      })();
    }
    return this.labelIndexPromise;
  }

  /**
   * Creates a single Linear label with the given (original-casing) name via the
   * `issueLabelCreate` mutation and returns its id, also caching it under the
   * normalized key so a later tag with the same key reuses it. Mirrors
   * `createItem`'s error discipline: an `auth` failure is re-thrown with team
   * context and a write-access hint, all other failures propagate unchanged, and
   * a soft failure (Linear returns `success: false`, a null label, or a label
   * missing its id) is surfaced as a non-retryable `bad_request` naming the
   * label so the failure is diagnosable rather than silently dropped.
   *
   * @param name the label name to create (original casing is preserved).
   * @returns the created label's Linear id.
   */
  private async createLabel(name: string): Promise<string> {
    const { query, variables } = this.buildCreateLabelMutation(name);

    let data: CreateLabelResponse;
    try {
      data = await this.client.request<CreateLabelResponse>(query, variables);
    } catch (err) {
      if (err instanceof LinearRequestError && err.info.code === 'auth') {
        throw new LinearRequestError({
          ...err.info,
          message: `Linear label creation failed for team ${this.config.teamId}: ${err.info.message}. Check that the configured token has write access to this team.`,
        });
      }
      throw err;
    }

    // Same soft-failure guard as the issue path: a missing id would let us
    // attach an empty label id to the issue, silently breaking label syncing.
    const issueLabel = data.issueLabelCreate?.issueLabel;
    if (!data.issueLabelCreate?.success || !issueLabel || !issueLabel.id) {
      throw new LinearRequestError({
        code: 'bad_request',
        retryable: false,
        message: `Linear rejected creation of label "${name}" for team ${this.config.teamId}.`,
      });
    }

    this.labelIdByName.set(normalizeLabelName(name), issueLabel.id);
    return issueLabel.id;
  }

  /**
   * Builds the `issueLabelCreate` mutation and its single `$input` variable. The
   * label is owned by the configured team; its `name` keeps the tag's original
   * casing (only lookups are normalized).
   */
  private buildCreateLabelMutation(name: string): {
    query: string;
    variables: Record<string, unknown>;
  } {
    const query = `
      mutation LinearCreateLabel($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name }
        }
      }
    `;

    return { query, variables: { input: { name, teamId: this.config.teamId } } };
  }

  /**
   * Creates the Linear Project an `epic` maps to via the `projectCreate` mutation
   * and returns its external id/url. Mirrors `createItem`'s issue path: an `auth`
   * failure is re-thrown with team context so callers see which token/team lacks
   * write access; all other failures propagate unchanged. A soft failure (Linear
   * returns `success: false`, a null project, or a project missing its id/url) is
   * surfaced as a non-retryable `bad_request` naming the epic so the failure is
   * diagnosable rather than persisted as a broken link.
   */
  private async createProjectFromEpic(item: CanonicalItem): Promise<ExternalItemResult> {
    const { query, variables } = this.buildCreateProjectMutation(item);

    let data: CreateProjectResponse;
    try {
      data = await this.client.request<CreateProjectResponse>(query, variables);
    } catch (err) {
      if (err instanceof LinearRequestError && err.info.code === 'auth') {
        throw new LinearRequestError({
          ...err.info,
          message: `Linear project creation failed for team ${this.config.teamId}: ${err.info.message}. Check that the configured token has write access to this team.`,
        });
      }
      throw err;
    }

    // Same soft-failure guard as the issue path: an empty/undefined id or url
    // would let the engine persist a SyncLink that can never address the project.
    const project = data.projectCreate?.project;
    if (!data.projectCreate?.success || !project || !project.id || !project.url) {
      throw new LinearRequestError({
        code: 'bad_request',
        retryable: false,
        message: `Linear rejected creation of ${item.level} "${item.title}" as a project for team ${this.config.teamId}.`,
      });
    }

    return { externalId: project.id, externalUrl: project.url };
  }

  /**
   * Builds the `projectCreate` mutation and its single `$input` variable. The
   * project is owned by the configured team — note `teamIds` is a required
   * *array* in `ProjectCreateInput`. `description` is composed in only when
   * defined.
   */
  private buildCreateProjectMutation(item: CanonicalItem): {
    query: string;
    variables: Record<string, unknown>;
  } {
    const query = `
      mutation LinearCreateProject($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          success
          project { id url }
        }
      }
    `;

    const input: Record<string, unknown> = {
      name: item.title,
      teamIds: [this.config.teamId],
    };
    if (item.description !== undefined) input['description'] = item.description;

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
   *
   * An `epic` is a Linear *Project*, so it delegates to
   * {@link updateProjectFromEpic} (`projectUpdate`) rather than `issueUpdate`.
   */
  async updateItem(id: string, item: CanonicalItem): Promise<void> {
    // An epic maps to a Linear Project, not an issue.
    if (item.level === 'epic') return this.updateProjectFromEpic(id, item);

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

  /**
   * Updates the Linear Project an `epic` maps to via the `projectUpdate` mutation,
   * pushing the name (and, when present, description). Mirrors `updateItem`'s issue
   * path: an `auth` failure is re-thrown with team context so callers see which
   * token/team lacks write access; all other failures propagate unchanged. A soft
   * failure (Linear returns `success: false`) is surfaced as a non-retryable
   * `bad_request` naming the project and item so the failure is diagnosable.
   */
  private async updateProjectFromEpic(id: string, item: CanonicalItem): Promise<void> {
    const { query, variables } = this.buildUpdateProjectMutation(id, item);

    let data: UpdateProjectResponse;
    try {
      data = await this.client.request<UpdateProjectResponse>(query, variables);
    } catch (err) {
      if (err instanceof LinearRequestError && err.info.code === 'auth') {
        throw new LinearRequestError({
          ...err.info,
          message: `Linear project update failed for team ${this.config.teamId}: ${err.info.message}. Check that the configured token has write access to this team.`,
        });
      }
      throw err;
    }

    if (!data.projectUpdate?.success) {
      throw new LinearRequestError({
        code: 'bad_request',
        retryable: false,
        message: `Linear rejected update of project ${id} (${item.level} "${item.title}") for team ${this.config.teamId}.`,
      });
    }

    return;
  }

  /**
   * Builds the `projectUpdate` mutation and its `$id` / `$input` variables. The
   * project is targeted by the top-level `id`; the input carries the name and
   * `description` only when defined. Name and description are the full scope here —
   * matching `buildUpdateIssueMutation`'s title/description discipline.
   */
  private buildUpdateProjectMutation(
    id: string,
    item: CanonicalItem,
  ): {
    query: string;
    variables: Record<string, unknown>;
  } {
    const query = `
      mutation LinearUpdateProject($id: String!, $input: ProjectUpdateInput!) {
        projectUpdate(id: $id, input: $input) {
          success
          project { id url }
        }
      }
    `;

    const input: Record<string, unknown> = {
      name: item.title,
    };
    if (item.description !== undefined) input['description'] = item.description;

    return { query, variables: { id, input } };
  }

  /**
   * @inheritdoc
   *
   * Establishes parent/child links by setting each child issue's `parent` field
   * via Linear's `issueUpdate` mutation (`input: { parentId }`), targeting the
   * child by its top-level `id`. Each child is updated in its own request,
   * fail-fast: the first child that fails throws and aborts the rest, matching
   * the `void` contract and `updateItem`'s single-write throw behavior. An empty
   * `childIds` resolves immediately with no network call.
   *
   * Idempotency is delegated to Linear: re-setting an identical `parentId` is a
   * no-op that still returns `success: true`, so this method never reads before
   * writing — staying symmetric with `createItem`/`updateItem`. An `auth` failure
   * is re-thrown with team context so callers see which token/team lacks write
   * access; all other failures propagate unchanged. A soft failure (Linear
   * returns `success: false`) is surfaced as a non-retryable `bad_request` naming
   * the child and the parent it was being linked to so the failure is diagnosable.
   */
  async linkItems(parentId: string, childIds: string[]): Promise<void> {
    if (childIds.length === 0) return;

    for (const childId of childIds) {
      const { query, variables } = this.buildLinkParentMutation(childId, parentId);

      let data: UpdateIssueResponse;
      try {
        data = await this.client.request<UpdateIssueResponse>(query, variables);
      } catch (err) {
        if (err instanceof LinearRequestError && err.info.code === 'auth') {
          throw new LinearRequestError({
            ...err.info,
            message: `Linear parent linkage failed for team ${this.config.teamId}: ${err.info.message}. Check that the configured token has write access to this team.`,
          });
        }
        throw err;
      }

      // A soft failure (`success: false`) is surfaced as a non-retryable
      // `bad_request`: resolving anyway would let the engine mark the link
      // established when Linear rejected it.
      if (!data.issueUpdate?.success) {
        throw new LinearRequestError({
          code: 'bad_request',
          retryable: false,
          message: `Linear rejected linking issue ${childId} to parent ${parentId} for team ${this.config.teamId}.`,
        });
      }
    }

    return;
  }

  /**
   * Builds the `issueUpdate` mutation and its `$id` / `$input` variables for a
   * parent link. The child is targeted by the top-level `id`, and the input
   * carries only `parentId` — the single field this operation manages.
   */
  private buildLinkParentMutation(
    childId: string,
    parentId: string,
  ): {
    query: string;
    variables: Record<string, unknown>;
  } {
    const query = `
      mutation LinearLinkParent($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { id url }
        }
      }
    `;

    return { query, variables: { id: childId, input: { parentId } } };
  }
}
