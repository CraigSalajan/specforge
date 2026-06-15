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
 * TER-9 PLACEHOLDER: this carries only the fields the adapter contract needs
 * today. The full canonical schema is a separate future deliverable and this
 * file will be expanded when it lands.
 */

/** Where an item sits in the spec hierarchy. */
export type CanonicalItemType = 'epic' | 'feature' | 'story' | 'criterion';

export interface CanonicalItem {
  /** SpecForge-local identifier; maps to `SyncLink.specItemId`. */
  localId: string;
  /** The item's level in the spec hierarchy. */
  type: CanonicalItemType;
  /** Short human-readable title/summary. */
  title: string;
  /** Long-form body/description in Markdown; optional. */
  description?: string;
}
