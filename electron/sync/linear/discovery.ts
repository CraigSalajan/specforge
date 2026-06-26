/**
 * Linear team/project discovery (TER-31).
 *
 * The Settings → Integrations picker needs the list of teams a credential can
 * see, and the projects under a chosen team, *before* any persisted
 * {@link Connection} (and therefore any {@link LinearAdapter}) exists. The
 * adapter's {@link LinearAdapter.getMetadata} can't serve this: it is
 * config-bound (it requires a `teamId`) and returns only labels, workflow
 * states, and the configured project's name — never the workspace's team/project
 * *lists*.
 *
 * These two standalone helpers fill that gap. They are intentionally NOT methods
 * on {@link LinearAdapter}: `discoverTeams` is config-independent (it needs no
 * team), and discovery runs against an *ephemeral* client built from a raw PAT
 * (see `electron/ipc/sync-deps.ts`), not from a persisted connection. They take
 * the already-constructed {@link LinearGraphQLClient} so the credential plumbing
 * (PAT-vs-OAuth header shape, retries, rate limits) stays entirely in the client
 * — these helpers are a pure translation concern, exactly like the adapter.
 *
 * ## Error surface (mirrors getMetadata)
 * An `auth` failure is re-thrown with discovery context so callers see it is the
 * token that needs fixing; all other failures (network/rate-limit/server)
 * propagate unchanged from the client. A `LinearRequestError` carries the shared
 * {@link AiErrorInfo} in `.info`, so the IPC layer maps these the same way it
 * maps `getMetadata` errors.
 *
 * @see ./linear-adapter for the config-bound metadata query this complements.
 * @see ../adapter for the {@link LinearTeam}/{@link LinearProject} result types.
 */

import type { LinearProject, LinearTeam } from '../adapter';
import type { LinearGraphQLClient } from './client';
import { LinearRequestError } from './errors';

/** Maximum projects fetched per team in a single discovery request. */
const PROJECTS_PAGE_SIZE = 250;

/** Shape of the `teams` discovery query's `data` payload. */
interface TeamsResponse {
  teams: { nodes: LinearTeam[] };
}

/** Shape of the `team(id).projects` discovery query's `data` payload. */
interface ProjectsResponse {
  team: { projects: { nodes: LinearProject[] } } | null;
}

/**
 * Lists every team the credential behind `client` can read. Config-independent —
 * it needs no team id — which is why it lives here rather than on the
 * config-bound adapter. Selects only `{ id key name }` so the payload stays small
 * and maps directly onto {@link LinearTeam}.
 *
 * @param client the injected GraphQL transport carrying the credential.
 * @returns every visible team, in Linear's returned order.
 * @throws {LinearRequestError} an `auth` failure is re-thrown with discovery
 * context; all other transport/GraphQL failures propagate unchanged.
 */
export async function discoverTeams(client: LinearGraphQLClient): Promise<LinearTeam[]> {
  const query = `
    query LinearDiscoverTeams {
      teams { nodes { id key name } }
    }
  `;

  let data: TeamsResponse;
  try {
    data = await client.request<TeamsResponse>(query);
  } catch (err) {
    if (err instanceof LinearRequestError && err.info.code === 'auth') {
      throw new LinearRequestError({
        ...err.info,
        message: `Linear team discovery failed: ${err.info.message}. Check that the token has read access to this workspace.`,
      });
    }
    throw err;
  }

  return data.teams.nodes.map((node) => ({ id: node.id, key: node.key, name: node.name }));
}

/**
 * Lists the projects under `teamId` visible to the credential behind `client`.
 * Selects only `{ id name }` (the picker shows the name, persists the id) and
 * caps at {@link PROJECTS_PAGE_SIZE} — a deliberate single-request bound matching
 * the adapter's first-page label fetch, ample for the per-team project picker.
 *
 * @param client the injected GraphQL transport carrying the credential.
 * @param teamId the Linear team whose projects to list.
 * @returns the team's projects, in Linear's returned order; `[]` when the team
 * resolves to `null` (not visible to the token).
 * @throws {LinearRequestError} an `auth` failure is re-thrown with discovery
 * context; all other transport/GraphQL failures propagate unchanged.
 */
export async function discoverProjects(
  client: LinearGraphQLClient,
  teamId: string,
): Promise<LinearProject[]> {
  const query = `
    query LinearDiscoverProjects($id: String!) {
      team(id: $id) {
        projects(first: ${PROJECTS_PAGE_SIZE}) { nodes { id name } }
      }
    }
  `;

  let data: ProjectsResponse;
  try {
    data = await client.request<ProjectsResponse>(query, { id: teamId });
  } catch (err) {
    if (err instanceof LinearRequestError && err.info.code === 'auth') {
      throw new LinearRequestError({
        ...err.info,
        message: `Linear project discovery failed for team ${teamId}: ${err.info.message}. Check that the token has read access to this team.`,
      });
    }
    throw err;
  }

  // A null team means the id isn't visible to this token — surface no projects
  // rather than throwing, so the picker simply shows an empty project list.
  const team = data.team;
  if (!team) return [];

  return team.projects.nodes.map((node) => ({ id: node.id, name: node.name }));
}
