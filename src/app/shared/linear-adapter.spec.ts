import { describe, expect, it, vi } from 'vitest';
import {
  LinearAdapter,
  type LinearConnectionConfig,
} from '../../../electron/sync/linear/linear-adapter';
import { ADAPTER_REGISTRY } from '../../../electron/sync/adapter-registry';
import type { LinearGraphQLClient } from '../../../electron/sync/linear/client';
import { LinearRequestError } from '../../../electron/sync/linear/errors';
import type { CanonicalItem } from '../../../electron/sync/canonical-item';

/**
 * Unit tests for the Linear adapter. The adapter is a pure translation layer
 * over the injected transport, so the suite drives it with fake clients and
 * never touches the network, the DB, or Electron. The TER-14 cases below cover
 * the provider name and the still-stubbed write operations (which never call the
 * client, so a hollow fake suffices); the TER-16 suite further down fakes the
 * `request` method to exercise the implemented `getMetadata`.
 */

/** The stubbed operations never call the client, so a hollow fake is enough. */
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

/**
 * TER-16: getMetadata queries the configured team's workflow states and labels
 * (and the optional project) and normalizes the result into provider-agnostic
 * {@link ProjectMetadata}. The injected transport is faked with a `vi.fn()`
 * `request`, so the suite touches no network. The query string passed to
 * `request` is inspected to prove the project selection is composed in only when
 * a projectId is configured.
 */
describe('LinearAdapter — TER-16: getMetadata', () => {
  /** Fakes the GraphQL transport with a single recordable `request` method. */
  function fakeClientWith(request: ReturnType<typeof vi.fn>): LinearGraphQLClient {
    return { request } as unknown as LinearGraphQLClient;
  }

  /** Reads the query string from the most recent `request` call. */
  function lastQuery(request: ReturnType<typeof vi.fn>): string {
    return request.mock.calls.at(-1)?.[0] as string;
  }

  it('normalizes a team-only response and omits the project selection', async () => {
    const request = vi.fn().mockResolvedValue({
      team: {
        id: 'team-1',
        name: 'Eng',
        states: {
          nodes: [{ id: 's1', name: 'Todo', type: 'unstarted', position: 1, color: '#abc' }],
        },
        labels: {
          nodes: [{ id: 'l1', name: 'bug', color: '#f00', isGroup: false, parent: null }],
        },
      },
    });
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const metadata = await adapter.getMetadata();

    expect(metadata.provider).toBe('linear');
    expect(metadata.projectId).toBe('team-1');
    expect(metadata.projectName).toBe('Eng');
    expect(metadata.url).toBeUndefined();
    expect(metadata.supportedLevels).toEqual(['epic', 'feature', 'story', 'criterion']);
    expect(metadata.workflowStates?.[0]).toEqual({
      id: 's1',
      name: 'Todo',
      type: 'unstarted',
      position: 1,
      color: '#abc',
    });
    expect(metadata.labels?.[0]).toEqual({
      id: 'l1',
      name: 'bug',
      color: '#f00',
      isGroup: false,
      parentId: undefined,
    });
    // The team-only path never names or selects a project.
    expect(lastQuery(request)).not.toContain('project(');
  });

  it('selects the project and prefers its name/url when a projectId is configured', async () => {
    const request = vi.fn().mockResolvedValue({
      team: {
        id: 'team-1',
        name: 'Eng',
        states: { nodes: [] },
        labels: { nodes: [] },
      },
      project: {
        id: 'proj-1',
        name: 'My Project',
        url: 'https://linear.app/x/project/proj-1',
      },
    });
    const adapter = new LinearAdapter(
      { teamId: 'team-1', projectId: 'proj-1' },
      fakeClientWith(request),
    );

    const metadata = await adapter.getMetadata();

    expect(metadata.projectId).toBe('proj-1');
    expect(metadata.projectName).toBe('My Project');
    expect(metadata.url).toBe('https://linear.app/x/project/proj-1');
    expect(lastQuery(request)).toContain('project(');
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ projectId: 'proj-1' });
  });

  it('passes label groups through and maps a parent group to parentId', async () => {
    const request = vi.fn().mockResolvedValue({
      team: {
        id: 'team-1',
        name: 'Eng',
        states: { nodes: [] },
        labels: {
          nodes: [
            { id: 'lg1', name: 'Priority', isGroup: true, parent: null },
            { id: 'l2', name: 'High', isGroup: false, parent: { id: 'lg1' } },
          ],
        },
      },
    });
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const metadata = await adapter.getMetadata();

    expect(metadata.labels?.[0]).toMatchObject({ id: 'lg1', isGroup: true, parentId: undefined });
    expect(metadata.labels?.[1]).toMatchObject({ id: 'l2', isGroup: false, parentId: 'lg1' });
  });

  it('surfaces an auth failure with team context while preserving the structured info', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        new LinearRequestError({ code: 'auth', retryable: false, message: 'Unauthorized' }),
      );
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const error = await adapter.getMetadata().then(
      () => {
        throw new Error('expected getMetadata to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(LinearRequestError);
    expect((error as LinearRequestError).info.code).toBe('auth');
    expect((error as LinearRequestError).info.retryable).toBe(false);
    // The structured info is preserved while the original message is augmented
    // with team context and a read-permission hint.
    expect((error as LinearRequestError).info.message).toContain('team-1');
    expect((error as LinearRequestError).info.message).toContain('Unauthorized');
    expect((error as LinearRequestError).info.message).toContain('read access');
  });

  it('rejects with a bad_request when the team is missing', async () => {
    const request = vi.fn().mockResolvedValue({ team: null });
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const error = await adapter.getMetadata().then(
      () => {
        throw new Error('expected getMetadata to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(LinearRequestError);
    expect((error as LinearRequestError).info.code).toBe('bad_request');
  });
});

/**
 * TER-17: createItem maps a {@link CanonicalItem} onto Linear's `issueCreate`
 * mutation — title/description into the issue, the configured team always the
 * target, the project attached when set, and the feature label applied only to
 * `feature`-level items. The injected transport is faked with a `vi.fn()`
 * `request`, so the suite touches no network. The `input` variable passed to
 * `request` is inspected to prove each optional field is composed in only when
 * its precondition holds.
 */
describe('LinearAdapter — TER-17: createItem', () => {
  /** Fakes the GraphQL transport with a single recordable `request` method. */
  function fakeClientWith(request: ReturnType<typeof vi.fn>): LinearGraphQLClient {
    return { request } as unknown as LinearGraphQLClient;
  }

  /** Reads the query string from the most recent `request` call. */
  function lastQuery(request: ReturnType<typeof vi.fn>): string {
    return request.mock.calls.at(-1)?.[0] as string;
  }

  /** Reads the `input` variable from the most recent `request` call. */
  function lastInput(request: ReturnType<typeof vi.fn>): Record<string, unknown> {
    return (request.mock.calls.at(-1)?.[1] as { input: Record<string, unknown> }).input;
  }

  /** A resolved `issueCreate` payload for the given issue fields. */
  function createdIssue(issue: { id: string; url: string }) {
    return { issueCreate: { success: true, issue } };
  }

  it('maps core fields, targets the team, and returns the external id/url', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        createdIssue({ id: 'iss-1', url: 'https://linear.app/x/issue/iss-1' }),
      );
    const item: CanonicalItem = {
      localId: 'local-1',
      level: 'story',
      title: 'Implement createItem',
      description: 'Map canonical items onto issueCreate.',
    };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const result = await adapter.createItem(item);

    expect(lastQuery(request)).toContain('issueCreate');
    expect(lastInput(request)).toEqual({
      title: 'Implement createItem',
      description: 'Map canonical items onto issueCreate.',
      teamId: 'team-1',
    });
    // Team-only config never composes in a project or labels.
    expect(lastInput(request)['projectId']).toBeUndefined();
    expect(lastInput(request)['labelIds']).toBeUndefined();
    expect(result).toEqual({
      externalId: 'iss-1',
      externalUrl: 'https://linear.app/x/issue/iss-1',
    });
  });

  it('includes the projectId when the config targets a project', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        createdIssue({ id: 'iss-1', url: 'https://linear.app/x/issue/iss-1' }),
      );
    const item: CanonicalItem = {
      localId: 'local-1',
      level: 'story',
      title: 'A story',
    };
    const adapter = new LinearAdapter(
      { teamId: 'team-1', projectId: 'proj-1' },
      fakeClientWith(request),
    );

    await adapter.createItem(item);

    expect(lastInput(request)['projectId']).toBe('proj-1');
  });

  it('attaches the feature label only for feature-level items', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        createdIssue({ id: 'iss-1', url: 'https://linear.app/x/issue/iss-1' }),
      );
    const adapter = new LinearAdapter(
      { teamId: 'team-1', featureLabelId: 'lbl-feat' },
      fakeClientWith(request),
    );

    const feature: CanonicalItem = { localId: 'local-1', level: 'feature', title: 'A feature' };
    await adapter.createItem(feature);
    expect(lastInput(request)['labelIds']).toEqual(['lbl-feat']);

    const story: CanonicalItem = { localId: 'local-2', level: 'story', title: 'A story' };
    await adapter.createItem(story);
    expect(lastInput(request)['labelIds']).toBeUndefined();
  });

  it('surfaces an auth failure with team context while preserving the structured info', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        new LinearRequestError({ code: 'auth', retryable: false, message: 'Unauthorized' }),
      );
    const item: CanonicalItem = { localId: 'local-1', level: 'story', title: 'A story' };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const error = await adapter.createItem(item).then(
      () => {
        throw new Error('expected createItem to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(LinearRequestError);
    expect((error as LinearRequestError).info.code).toBe('auth');
    expect((error as LinearRequestError).info.retryable).toBe(false);
    // The structured info is preserved while the original message is augmented
    // with team context and a write-permission hint.
    expect((error as LinearRequestError).info.message).toContain('team-1');
    expect((error as LinearRequestError).info.message).toContain('Unauthorized');
    expect((error as LinearRequestError).info.message).toContain('write access');
  });

  it('rejects with a bad_request when Linear reports a soft failure', async () => {
    const request = vi.fn().mockResolvedValue({ issueCreate: { success: false, issue: null } });
    const item: CanonicalItem = { localId: 'local-1', level: 'story', title: 'A story' };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const error = await adapter.createItem(item).then(
      () => {
        throw new Error('expected createItem to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(LinearRequestError);
    expect((error as LinearRequestError).info.code).toBe('bad_request');
  });

  it('rejects a malformed success whose issue lacks an id or url', async () => {
    // A `success: true` envelope carrying an issue with empty id/url must not
    // yield an ExternalItemResult: persisting an empty externalId/url would
    // break SyncLink idempotency. It is rejected as a non-retryable bad_request.
    const request = vi
      .fn()
      .mockResolvedValue({ issueCreate: { success: true, issue: { id: '', url: '' } } });
    const item: CanonicalItem = { localId: 'local-1', level: 'story', title: 'A story' };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const error = await adapter.createItem(item).then(
      () => {
        throw new Error('expected createItem to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(LinearRequestError);
    expect((error as LinearRequestError).info.code).toBe('bad_request');
    expect((error as LinearRequestError).info.retryable).toBe(false);
  });
});
