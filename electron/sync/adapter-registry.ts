/**
 * Adapter registry — the Sync Engine's per-provider adapter selection point.
 *
 * A typed factory map from {@link AdapterName} to a function that builds the
 * concrete {@link IAdapter} for that provider. The engine looks a provider up
 * here instead of `new`-ing a specific adapter, which keeps it decoupled from
 * any single provider's constructor shape while still type-checking each entry.
 *
 * This mirrors the data-driven precedent of `LEVEL_MAPPINGS` in
 * `./level-mapping` — a static, stateless map keyed by provider, not a mutable
 * singleton. Each factory returns the {@link IAdapter} abstraction (never the
 * concrete class), so callers depend only on the contract. Only `linear` is
 * populated today; future providers add their own typed entry as they land.
 *
 * @see ./adapter for the provider-agnostic {@link IAdapter} contract.
 * @see ./linear/linear-adapter for the Linear factory's concrete adapter.
 */

import type { IAdapter } from './adapter';
import type { LinearGraphQLClient } from './linear/client';
import {
  LinearAdapter,
  type LinearConnectionConfig,
} from './linear/linear-adapter';

/**
 * Per-provider adapter factories. Each key builds the {@link IAdapter} for one
 * provider from its connection target and an injected transport client.
 */
export const ADAPTER_REGISTRY = {
  /** Build the Linear adapter for a team/project target over the given client. */
  linear: (
    config: LinearConnectionConfig,
    client: LinearGraphQLClient,
  ): IAdapter => new LinearAdapter(config, client),
} as const;
