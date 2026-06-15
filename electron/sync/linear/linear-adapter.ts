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
 * ## Why this is a skeleton
 * The four {@link IAdapter} operations are intentionally stubbed and throw a
 * clear "not implemented yet" error tagged with the ticket that fills them in:
 * `getMetadata` (TER-16), `createItem` (TER-17), `updateItem` (TER-18), and
 * `linkItems` (TER-20). Wiring up real GraphQL queries/mutations is out of scope
 * for this ticket; only the contract surface and the injection seams land here.
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
  ProjectMetadata,
} from '../adapter';
import type { CanonicalItem } from '../canonical-item';
import type { LinearGraphQLClient } from './client';

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

/**
 * Skeleton Linear {@link IAdapter}. Holds the connection target and the injected
 * transport; every operation is a stub awaiting its follow-up ticket.
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

  /** @inheritdoc */
  async getMetadata(): Promise<ProjectMetadata> {
    throw new Error('LinearAdapter.getMetadata not implemented yet (TER-16)');
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
