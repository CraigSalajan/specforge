import { describe, expect, it } from 'vitest';
import {
  LinearAdapter,
  type LinearConnectionConfig,
} from '../../../electron/sync/linear/linear-adapter';
import { ADAPTER_REGISTRY } from '../../../electron/sync/adapter-registry';
import type { LinearGraphQLClient } from '../../../electron/sync/linear/client';
import type { CanonicalItem } from '../../../electron/sync/canonical-item';

/**
 * Unit tests for the skeleton Linear adapter (TER-14). The adapter is a pure
 * translation layer and its operations are stubbed until later tickets, so the
 * injected transport is never touched — a hollow `{}` cast to
 * {@link LinearGraphQLClient} suffices, keeping the suite free of the network,
 * the DB, and Electron.
 */

/** The skeleton never calls the client, so a hollow fake is enough. */
const fakeClient = {} as unknown as LinearGraphQLClient;

/** A minimal canonical item using only the fields CanonicalItem requires. */
const sampleItem: CanonicalItem = {
  localId: 'local-1',
  level: 'story',
  title: 'A sample story',
};

describe('LinearAdapter — AC1: name & stubbed operations', () => {
  it('reports the linear provider name', () => {
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClient);

    expect(adapter.name).toBe('linear');
  });

  it('rejects getMetadata as not implemented', async () => {
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClient);

    await expect(adapter.getMetadata()).rejects.toThrow(/not implemented/i);
  });

  it('rejects createItem as not implemented', async () => {
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClient);

    await expect(adapter.createItem(sampleItem)).rejects.toThrow(/not implemented/i);
  });

  it('rejects updateItem as not implemented', async () => {
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClient);

    await expect(adapter.updateItem('ext-1', sampleItem)).rejects.toThrow(/not implemented/i);
  });

  it('rejects linkItems as not implemented', async () => {
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClient);

    await expect(adapter.linkItems('parent-1', ['child-1'])).rejects.toThrow(/not implemented/i);
  });
});

describe('ADAPTER_REGISTRY — AC2: linear factory', () => {
  it('builds a linear adapter whose four operations are functions', () => {
    const adapter = ADAPTER_REGISTRY.linear({ teamId: 'team-1' }, fakeClient);

    expect(adapter.name).toBe('linear');
    expect(typeof adapter.getMetadata).toBe('function');
    expect(typeof adapter.createItem).toBe('function');
    expect(typeof adapter.updateItem).toBe('function');
    expect(typeof adapter.linkItems).toBe('function');
  });
});

describe('LinearAdapter — AC3: connection config exposure', () => {
  it('exposes the team and project target via the readonly config', () => {
    const config: LinearConnectionConfig = { teamId: 'team-1', projectId: 'project-1' };
    const adapter = new LinearAdapter(config, fakeClient);

    expect(adapter.config).toEqual(config);
    expect(adapter.config.teamId).toBe('team-1');
    expect(adapter.config.projectId).toBe('project-1');
  });

  it('treats projectId as optional', () => {
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClient);

    expect(adapter.config.teamId).toBe('team-1');
    expect(adapter.config.projectId).toBeUndefined();
  });
});
