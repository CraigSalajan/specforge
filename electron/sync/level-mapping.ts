/**
 * Data-driven field-mapping strategy for the canonical spec hierarchy.
 *
 * Each adapter must resolve a SpecForge `CanonicalLevel` (epic → feature →
 * story → criterion) to its provider-native work-item type. Some providers have
 * a flatter hierarchy than SpecForge, so a level may be "folded" into its parent
 * item rather than created as a standalone work item — this is the canonical
 * model's graceful degradation (see `docs/PM-TOOL-INTEGRATION.md`).
 */

import type { AdapterName } from './adapter';
import type { CanonicalLevel } from './canonical-item';

/**
 * Whether a canonical level becomes its own work item in the provider, or is
 * folded into its parent item (graceful degradation where the target hierarchy
 * is flatter than SpecForge's).
 */
export type LevelRepresentation = 'item' | 'inline';

/** How one provider represents a single canonical level. */
export interface NativeLevel {
  /** Provider-native work-item type/name (e.g. 'Epic', 'Project', 'Sub-issue'). */
  nativeType: string;
  /**
   * 'item'   — created as its own work item of `nativeType`.
   * 'inline' — collapsed into the parent item (e.g. acceptance criteria rendered
   *            into a Linear description or a GitHub checklist); no standalone item.
   */
  representation: LevelRepresentation;
  /**
   * When true, children of an item at this level join it as members (e.g. Linear
   * project membership) rather than being parent-linked to it. Lets the engine
   * choose project association over a native parent link without knowing provider
   * specifics.
   */
  containerForChildren?: boolean;
}

/** A provider's complete strategy: every canonical level → its native representation. */
export type LevelMappingStrategy = Record<CanonicalLevel, NativeLevel>;

/**
 * This encodes the TER-10 ticket's mapping table as the source of truth.
 * `docs/PM-TOOL-INTEGRATION.md` lists richer alternatives (e.g. Linear
 * Initiative for Epic, GitHub tracking issue) that a concrete adapter may later
 * refine.
 */
export const LEVEL_MAPPINGS: Record<AdapterName, LevelMappingStrategy> = {
  ado: {
    epic: { nativeType: 'Epic', representation: 'item' },
    feature: { nativeType: 'Feature', representation: 'item' },
    story: { nativeType: 'Story', representation: 'item' },
    criterion: { nativeType: 'Task', representation: 'item' },
  },
  linear: {
    epic: { nativeType: 'Project', representation: 'item', containerForChildren: true },
    feature: { nativeType: 'Story', representation: 'item' },
    story: { nativeType: 'Sub-issue', representation: 'item' },
    criterion: { nativeType: 'Description', representation: 'inline' },
  },
  jira: {
    epic: { nativeType: 'Epic', representation: 'item' },
    feature: { nativeType: 'Feature', representation: 'item' },
    story: { nativeType: 'Story', representation: 'item' },
    criterion: { nativeType: 'Sub-task', representation: 'item' },
  },
  github: {
    epic: { nativeType: 'Milestone', representation: 'item' },
    feature: { nativeType: 'Issue', representation: 'item' },
    story: { nativeType: 'Sub-issue', representation: 'item' },
    criterion: { nativeType: 'Checklist', representation: 'inline' },
  },
};

/** Resolve how `provider` represents a given canonical `level`. */
export function resolveLevel(
  provider: AdapterName,
  level: CanonicalLevel,
): NativeLevel {
  return LEVEL_MAPPINGS[provider][level];
}
