/**
 * Provider-agnostic representation of a SpecForge planning item.
 *
 * SpecForge plans are a hierarchy — epic → feature → story → acceptance
 * criteria. A `CanonicalItem` is one node in that chain, expressed without any
 * reference to a particular PM tool. Adapters (see `./adapter.ts`) translate
 * these canonical items into provider-native work items, and the canonical
 * model is expected to "degrade gracefully" where a target's hierarchy is
 * flatter than SpecForge's (see `docs/PM-TOOL-INTEGRATION.md`).
 *
 * @see ./level-mapping for how each provider resolves a `CanonicalLevel`.
 */

/** Where an item sits in the spec hierarchy. */
export type CanonicalLevel = 'epic' | 'feature' | 'story' | 'criterion';

export interface CanonicalItem {
  /** SpecForge-local identifier; maps to `SyncLink.specItemId`. */
  localId: string;
  /** The item's level in the spec hierarchy. */
  level: CanonicalLevel;
  /** Short human-readable title/summary. */
  title: string;
  /** Long-form body/description in Markdown; optional. */
  description?: string;
  /**
   * Acceptance criteria, one testable item per entry. Adapters either create
   * these as their own work items (e.g. ADO Task) or fold them into the parent
   * (e.g. Linear description, GitHub checklist) per the level-mapping strategy.
   */
  criteria?: string[];
  /** Free-form labels/tags carried to the provider where supported. */
  tags?: string[];
  /**
   * The `localId` of this item's parent in the spec hierarchy; absent for root
   * items. The Sync Engine resolves this to a native parent link via
   * `IAdapter.linkItems` after creation; it is a SpecForge-local id, not a
   * provider id.
   */
  parentLocalId?: string;
}
