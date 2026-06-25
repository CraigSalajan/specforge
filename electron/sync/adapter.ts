/**
 * Provider-agnostic contract every PM-tool adapter implements.
 *
 * Adapters run in the Electron main process and talk to each provider's
 * REST/GraphQL API (Jira / ADO / Linear / GitHub). The Sync Engine depends only
 * on this interface, never on a concrete adapter, which keeps the engine
 * decoupled from any single provider; concrete adapters (e.g. the Linear
 * adapter, TER-14) implement `IAdapter`.
 *
 * Idempotency and ordering are the Sync Engine's responsibility, not the
 * adapter's: an adapter performs the requested provider operation and reports
 * the result, while the engine decides what to push, in what order, and which
 * unchanged items to skip.
 */

import type { CanonicalItem, CanonicalLevel } from './canonical-item';

/** Identifier of a supported PM provider. */
export type AdapterName = 'jira' | 'ado' | 'linear' | 'github';

/** A workflow state (issue status) exposed by the target. */
export interface WorkflowStateInfo {
  id: string;
  name: string;
  /** Provider state category, e.g. Linear's triage|backlog|unstarted|started|completed|canceled. */
  type: string;
  position?: number;
  color?: string;
}

/** A label exposed by the target, for the label-sync feature. */
export interface LabelInfo {
  id: string;
  name: string;
  color?: string;
  /** Parent label id when this label belongs to a label group. */
  parentId?: string;
  /** True when this is a label group (container) rather than an applicable label. */
  isGroup?: boolean;
}

/**
 * Metadata describing the connected target project and its capabilities.
 * First pass — expected to be extended with provider-specific fields as each
 * adapter lands.
 */
export interface ProjectMetadata {
  /** Which provider this project belongs to. */
  provider: AdapterName;
  /**
   * Provider-native project identifier (Jira project key, Linear project id,
   * ADO project id, GitHub project node id).
   */
  projectId: string;
  /** Human-readable name for display. */
  projectName: string;
  /** Deep link to the project, if available. */
  url?: string;
  /**
   * Hierarchy levels this target can represent natively; drives graceful
   * degradation where the target is flatter than the canonical model.
   */
  supportedLevels: CanonicalLevel[];
  /** Workflow states the target exposes. Optional; populated by adapters that support discovery. */
  workflowStates?: WorkflowStateInfo[];
  /** Labels available in the target. Optional; populated by adapters that support discovery. */
  labels?: LabelInfo[];
}

/**
 * The durable handle the Sync Engine persists as a `SyncLink` (see
 * `electron/db/repositories/sync-links.repo.ts`) so a later push for the same
 * item is idempotent rather than a duplicate. These fields mirror
 * `SyncLink.externalId` / `SyncLink.externalUrl`.
 */
export interface ExternalItemResult {
  /**
   * Provider-native id/key (Jira key, ADO id, Linear id, GitHub node id).
   */
  externalId: string;
  /** Deep link back to the created item. */
  externalUrl: string;
}

/**
 * A snapshot of a previously-synced item's current state in the provider, read
 * back during a pull/reconcile (TER-23) so the engine can detect changes made
 * outside SpecForge. Fields are normalized across providers: an epic's Linear
 * *Project* and a story's Linear *Issue* both project onto this shape (a Project
 * has no `description`-style `title`, so the adapter maps its `name` here).
 */
export interface RemoteItemState {
  /** Provider-native id of the remote item (Linear node id). */
  externalId: string;
  /** Deep link back to the remote item. */
  externalUrl: string;
  /**
   * The remote item's last-modified timestamp as ISO 8601, from the provider's
   * `updatedAt` (Linear `DateTime`, e.g. `2025-01-24T19:00:15.885Z`). The
   * reconcile engine compares this against the link's pull baseline to decide
   * whether the remote changed since SpecForge last touched it.
   */
  updatedAt: string;
  /** The remote item's title (a Linear Issue's `title`, or a Project's `name`). */
  title: string;
  /** The remote item's description/body; omitted when the remote has none. */
  description?: string;
}

/**
 * Optional per-call context the Sync Engine threads into createItem so an item
 * can be attached to a provider "container" resolved at runtime — e.g. the
 * Linear Project created for an ancestor Epic. Adapters whose provider doesn't
 * model such a container ignore it.
 */
export interface CreateItemContext {
  /**
   * External id of the provider container (e.g. Linear project) this item should
   * join, resolved by the engine from the nearest ancestor the provider maps to a
   * container. Absent when the item has no container ancestor.
   */
  projectExternalId?: string;
}

export interface IAdapter {
  /** Which provider this adapter targets. */
  readonly name: AdapterName;

  /**
   * Fetch the connected target project's metadata and capabilities.
   *
   * @returns the project metadata, including which hierarchy levels the target
   * supports natively.
   * @throws Rejects if the connection is unauthorized or the project is
   * unreachable.
   */
  getMetadata(): Promise<ProjectMetadata>;

  /**
   * Create a single work item in the provider from a canonical item.
   *
   * Callers (the Sync Engine) handle ordering and idempotency/skip-unchanged;
   * this method just performs the create and reports the new item's handle.
   *
   * @param item the canonical item to create.
   * @param context optional engine-supplied container context (e.g. the external
   * id of the Linear Project resolved from an ancestor Epic) the item should join
   * at create time. Optional so callers and providers that don't model a
   * container are unaffected.
   * @returns the external id and deep link of the created item.
   * @throws Rejects on validation failure (missing required provider fields),
   * auth failure, or transport failure.
   */
  createItem(item: CanonicalItem, context?: CreateItemContext): Promise<ExternalItemResult>;

  /**
   * Update the existing provider item identified by `id` to match the canonical
   * item.
   *
   * @param id the provider-native external id previously returned by
   * `createItem`.
   * @param item the canonical item whose state the provider item should reflect.
   * @throws Rejects if the item no longer exists, or on auth/transport failure.
   */
  updateItem(id: string, item: CanonicalItem): Promise<void>;

  /**
   * Establish parent/child links in the provider (Jira epic link, ADO
   * `System.Parent`, Linear `parentId`, GitHub sub-issues) between items
   * identified by their external ids.
   *
   * @param parentId the provider-native external id of the parent item.
   * @param childIds the provider-native external ids of the child items.
   * @throws Rejects on auth/transport failure or if a referenced item is
   * missing.
   */
  linkItems(parentId: string, childIds: string[]): Promise<void>;

  /**
   * Read back the current remote state of a previously-synced item so the engine
   * can detect changes made outside SpecForge (the pull half of bi-directional
   * sync, TER-23).
   *
   * The `level` drives which provider object is read: per `./level-mapping`, an
   * `epic` maps to the provider's container (a Linear *Project*) and every other
   * level to an *Issue*; the adapter routes the read accordingly.
   *
   * This is the first **read-direction** method on what is otherwise a write-only
   * contract (`createItem`/`updateItem`/`linkItems`). Only the Linear adapter
   * implements it today; other providers may leave it unimplemented until their
   * pull path lands.
   *
   * @param externalId the provider-native id previously returned by `createItem`.
   * @param level the canonical level of the item, selecting container-vs-item.
   * @returns the normalized {@link RemoteItemState}, or `null` when the remote
   * item no longer exists (the provider returned a null node for that id).
   * @throws Rejects on auth/transport/GraphQL failure (the same way the write
   * methods propagate transport errors); a missing item is `null`, not a throw.
   */
  getRemoteState(externalId: string, level: CanonicalLevel): Promise<RemoteItemState | null>;
}
