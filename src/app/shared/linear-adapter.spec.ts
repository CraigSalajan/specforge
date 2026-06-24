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
 * never touches the network, the DB, or Electron. The TER-14 case below covers
 * the provider name (which never calls the client, so a hollow fake suffices);
 * the TER-16/TER-17/TER-18/TER-19 suites further down fake the `request` method
 * to exercise the implemented `getMetadata`, `createItem`, `updateItem`, and
 * `linkItems`.
 */

/** A name check never calls the client, so a hollow fake is enough. */
const fakeClient = {} as unknown as LinearGraphQLClient;

describe('LinearAdapter — AC1: name', () => {
  it('reports the linear provider name', () => {
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClient);

    expect(adapter.name).toBe('linear');
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

  it('paginates labels across pages and returns the merged label set', async () => {
    // Page 1 reports a next page; the follow-up `LinearTeamLabelsPage` query
    // (it carries a `cursor` variable) returns the tail. getMetadata must merge
    // both pages and issue exactly two requests.
    const request = vi.fn().mockImplementation((query: string) => {
      if (query.includes('LinearTeamLabelsPage')) {
        return Promise.resolve({
          team: {
            labels: {
              nodes: [
                { id: 'l3', name: 'tail-a', isGroup: false, parent: null },
                { id: 'l4', name: 'tail-b', isGroup: false, parent: null },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return Promise.resolve({
        team: {
          id: 'team-1',
          name: 'Eng',
          states: { nodes: [] },
          labels: {
            nodes: [
              { id: 'l1', name: 'head-a', isGroup: false, parent: null },
              { id: 'l2', name: 'head-b', isGroup: false, parent: null },
            ],
            pageInfo: { hasNextPage: true, endCursor: 'cur-1' },
          },
        },
      });
    });
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const metadata = await adapter.getMetadata();

    expect(request).toHaveBeenCalledTimes(2);
    // The follow-up request carried the prior page's endCursor.
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: 'cur-1' });
    expect(metadata.labels?.map((l) => l.id)).toEqual(['l1', 'l2', 'l3', 'l4']);
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

/**
 * TER-18: updateItem pushes the managed fields of a {@link CanonicalItem} onto
 * Linear's `issueUpdate` mutation — the title and (when present) description
 * overwrite the existing issue, which is targeted by the top-level `id` rather
 * than by team. The injected transport is faked with a `vi.fn()` `request`, so
 * the suite touches no network. The `id` and `input` variables passed to
 * `request` are inspected to prove the issue is addressed by id and that
 * `description` is composed in only when defined. Material-change gating lives in
 * the engine, so this method always pushes the current managed fields when called.
 */
describe('LinearAdapter — TER-18: updateItem', () => {
  /** Fakes the GraphQL transport with a single recordable `request` method. */
  function fakeClientWith(request: ReturnType<typeof vi.fn>): LinearGraphQLClient {
    return { request } as unknown as LinearGraphQLClient;
  }

  /** Reads the query string from the most recent `request` call. */
  function lastQuery(request: ReturnType<typeof vi.fn>): string {
    return request.mock.calls.at(-1)?.[0] as string;
  }

  /** Reads the `id` variable from the most recent `request` call. */
  function lastId(request: ReturnType<typeof vi.fn>): string {
    return (request.mock.calls.at(-1)?.[1] as { id: string }).id;
  }

  /** Reads the `input` variable from the most recent `request` call. */
  function lastInput(request: ReturnType<typeof vi.fn>): Record<string, unknown> {
    return (request.mock.calls.at(-1)?.[1] as { input: Record<string, unknown> }).input;
  }

  /** A resolved `issueUpdate` payload for the given issue fields. */
  function updatedIssue(issue: { id: string; url: string }) {
    return { issueUpdate: { success: true, issue } };
  }

  it('issues an issueUpdate mutation targeting the issue by id with title/description', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(updatedIssue({ id: 'iss-1', url: 'https://linear.app/x/issue/iss-1' }));
    const item: CanonicalItem = {
      localId: 'local-1',
      level: 'story',
      title: 'Implement updateItem',
      description: 'Map canonical items onto issueUpdate.',
    };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.updateItem('issue-ext-id', item);

    expect(lastQuery(request)).toContain('issueUpdate');
    expect(lastId(request)).toBe('issue-ext-id');
    expect(lastInput(request)).toEqual({
      title: 'Implement updateItem',
      description: 'Map canonical items onto issueUpdate.',
    });
    // The issue is targeted by the top-level id, never by team.
    expect(lastInput(request)['teamId']).toBeUndefined();
  });

  it('omits description from input when the item has none', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(updatedIssue({ id: 'iss-1', url: 'https://linear.app/x/issue/iss-1' }));
    const item: CanonicalItem = {
      localId: 'local-1',
      level: 'story',
      title: 'A story',
    };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.updateItem('issue-ext-id', item);

    expect(lastInput(request)['title']).toBe('A story');
    expect(lastInput(request)).not.toHaveProperty('description');
  });

  it('resolves to undefined on success', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(updatedIssue({ id: 'iss-1', url: 'https://linear.app/x/issue/iss-1' }));
    const item: CanonicalItem = { localId: 'local-1', level: 'story', title: 'A story' };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    expect(await adapter.updateItem('issue-ext-id', item)).toBeUndefined();
  });

  it('surfaces an auth failure with team context while preserving the structured info', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        new LinearRequestError({ code: 'auth', retryable: false, message: 'Unauthorized' }),
      );
    const item: CanonicalItem = { localId: 'local-1', level: 'story', title: 'A story' };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const error = await adapter.updateItem('issue-ext-id', item).then(
      () => {
        throw new Error('expected updateItem to reject');
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
    expect((error as LinearRequestError).info.message).toMatch(/write access/i);
  });

  it('rejects with a non-retryable bad_request when Linear reports success:false', async () => {
    const request = vi.fn().mockResolvedValue({ issueUpdate: { success: false, issue: null } });
    const item: CanonicalItem = { localId: 'local-1', level: 'story', title: 'A story' };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const error = await adapter.updateItem('issue-ext-id', item).then(
      () => {
        throw new Error('expected updateItem to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(LinearRequestError);
    expect((error as LinearRequestError).info.code).toBe('bad_request');
    expect((error as LinearRequestError).info.retryable).toBe(false);
  });
});

/**
 * TER-19: linkItems sets each child issue's `parent` field via Linear's
 * `issueUpdate` mutation (`input: { parentId }`), targeting the child by its
 * top-level `id`. Each child is updated in its own request, fail-fast. The
 * injected transport is faked with a `vi.fn()` `request`, so the suite touches
 * no network. The `id` and `input` variables passed to `request` are inspected
 * to prove each child is addressed by id and carries the parent id. Idempotency
 * is delegated to Linear, so this method never reads before writing.
 */
describe('LinearAdapter.linkItems', () => {
  /** Fakes the GraphQL transport with a single recordable `request` method. */
  function fakeClientWith(request: ReturnType<typeof vi.fn>): LinearGraphQLClient {
    return { request } as unknown as LinearGraphQLClient;
  }

  /** Reads the query string from the most recent `request` call. */
  function lastQuery(request: ReturnType<typeof vi.fn>): string {
    return request.mock.calls.at(-1)?.[0] as string;
  }

  /** Reads the `id` variable from the most recent `request` call. */
  function lastId(request: ReturnType<typeof vi.fn>): string {
    return (request.mock.calls.at(-1)?.[1] as { id: string }).id;
  }

  /** Reads the `input` variable from the most recent `request` call. */
  function lastInput(request: ReturnType<typeof vi.fn>): Record<string, unknown> {
    return (request.mock.calls.at(-1)?.[1] as { input: Record<string, unknown> }).input;
  }

  /** A resolved `issueUpdate` payload for the given issue fields. */
  function updatedIssue(issue: { id: string; url: string }) {
    return { issueUpdate: { success: true, issue } };
  }

  it('sets parentId on the child via an issueUpdate mutation targeting it by id', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(updatedIssue({ id: 'child-1', url: 'https://linear.app/x/issue/child-1' }));
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.linkItems('parent-1', ['child-1']);

    expect(lastQuery(request)).toContain('issueUpdate');
    expect(lastId(request)).toBe('child-1');
    expect(lastInput(request)['parentId']).toBe('parent-1');
  });

  it('links multiple children, one request each with the correct child id', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(updatedIssue({ id: 'child', url: 'https://linear.app/x/issue/child' }));
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.linkItems('parent-1', ['child-1', 'child-2']);

    expect(request).toHaveBeenCalledTimes(2);
    expect((request.mock.calls[0]?.[1] as { id: string }).id).toBe('child-1');
    expect(
      (request.mock.calls[0]?.[1] as { input: Record<string, unknown> }).input['parentId'],
    ).toBe('parent-1');
    expect((request.mock.calls[1]?.[1] as { id: string }).id).toBe('child-2');
    expect(
      (request.mock.calls[1]?.[1] as { input: Record<string, unknown> }).input['parentId'],
    ).toBe('parent-1');
  });

  it('resolves without calling the client when childIds is empty', async () => {
    const request = vi.fn();
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.linkItems('parent-1', []);

    expect(request).not.toHaveBeenCalled();
  });

  it('resolves to undefined on success', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(updatedIssue({ id: 'child-1', url: 'https://linear.app/x/issue/child-1' }));
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    expect(await adapter.linkItems('parent-1', ['child-1'])).toBeUndefined();
  });

  it('surfaces an auth failure with team context while preserving the structured info', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        new LinearRequestError({ code: 'auth', retryable: false, message: 'Unauthorized' }),
      );
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const error = await adapter.linkItems('parent-1', ['child-1']).then(
      () => {
        throw new Error('expected linkItems to reject');
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
    expect((error as LinearRequestError).info.message).toMatch(/write access/i);
  });

  it('rejects with a non-retryable bad_request when Linear reports success:false', async () => {
    const request = vi.fn().mockResolvedValue({ issueUpdate: { success: false, issue: null } });
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const error = await adapter.linkItems('parent-1', ['child-1']).then(
      () => {
        throw new Error('expected linkItems to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(LinearRequestError);
    expect((error as LinearRequestError).info.code).toBe('bad_request');
    expect((error as LinearRequestError).info.retryable).toBe(false);
  });
});

/**
 * TER-20: Epic → Project. Linear maps `epic → Project` and `feature/story →
 * Issue`. An `epic`-level create/update therefore targets a Linear *project*:
 * `createItem` delegates to `projectCreate` and `updateItem` to `projectUpdate`.
 * Descendant issues join their Epic's project via `projectId`, resolved by the
 * engine and threaded into `createItem` via the {@link CreateItemContext}; that
 * resolved id falls back to the static `config.projectId`. The injected transport
 * is faked with a `vi.fn()` `request`, so the suite touches no network.
 */
describe('LinearAdapter — TER-20: Epic → Project', () => {
  /** Fakes the GraphQL transport with a single recordable `request` method. */
  function fakeClientWith(request: ReturnType<typeof vi.fn>): LinearGraphQLClient {
    return { request } as unknown as LinearGraphQLClient;
  }

  /** Reads the query string from the most recent `request` call. */
  function lastQuery(request: ReturnType<typeof vi.fn>): string {
    return request.mock.calls.at(-1)?.[0] as string;
  }

  /** Reads the `id` variable from the most recent `request` call. */
  function lastId(request: ReturnType<typeof vi.fn>): string {
    return (request.mock.calls.at(-1)?.[1] as { id: string }).id;
  }

  /** Reads the `input` variable from the most recent `request` call. */
  function lastInput(request: ReturnType<typeof vi.fn>): Record<string, unknown> {
    return (request.mock.calls.at(-1)?.[1] as { input: Record<string, unknown> }).input;
  }

  /** A resolved `projectCreate` payload for the given project fields. */
  function createdProject(project: { id: string; url: string }) {
    return { projectCreate: { success: true, project } };
  }

  /** A resolved `projectUpdate` payload for the given project fields. */
  function updatedProject(project: { id: string; url: string }) {
    return { projectUpdate: { success: true, project } };
  }

  it('creates an epic as a Linear project, targeting the team via teamIds', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        createdProject({ id: 'proj-1', url: 'https://linear.app/x/project/proj-1' }),
      );
    const epic: CanonicalItem = {
      localId: 'local-1',
      level: 'epic',
      title: 'An epic',
      description: 'Epic body.',
    };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const result = await adapter.createItem(epic);

    expect(lastQuery(request)).toContain('projectCreate');
    expect(lastInput(request)).toEqual({
      name: 'An epic',
      description: 'Epic body.',
      teamIds: ['team-1'],
    });
    expect(result).toEqual({
      externalId: 'proj-1',
      externalUrl: 'https://linear.app/x/project/proj-1',
    });
  });

  it('omits description from the project input when the epic has none', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        createdProject({ id: 'proj-1', url: 'https://linear.app/x/project/proj-1' }),
      );
    const epic: CanonicalItem = { localId: 'local-1', level: 'epic', title: 'An epic' };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.createItem(epic);

    expect(lastInput(request)).toEqual({ name: 'An epic', teamIds: ['team-1'] });
    expect(lastInput(request)).not.toHaveProperty('description');
  });

  it('sets a non-epic issue projectId from the context container even when config has none', async () => {
    const request = vi.fn().mockResolvedValue({
      issueCreate: {
        success: true,
        issue: { id: 'iss-1', url: 'https://linear.app/x/issue/iss-1' },
      },
    });
    const story: CanonicalItem = { localId: 'local-1', level: 'story', title: 'A story' };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.createItem(story, { projectExternalId: 'proj-9' });

    expect(lastQuery(request)).toContain('issueCreate');
    expect(lastInput(request)['projectId']).toBe('proj-9');
  });

  it('prefers the context container over the configured projectId', async () => {
    const request = vi.fn().mockResolvedValue({
      issueCreate: {
        success: true,
        issue: { id: 'iss-1', url: 'https://linear.app/x/issue/iss-1' },
      },
    });
    const story: CanonicalItem = { localId: 'local-1', level: 'story', title: 'A story' };
    const adapter = new LinearAdapter(
      { teamId: 'team-1', projectId: 'cfg' },
      fakeClientWith(request),
    );

    await adapter.createItem(story, { projectExternalId: 'ctx' });

    expect(lastInput(request)['projectId']).toBe('ctx');
  });

  it('updates an epic via projectUpdate, targeting the project by id', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        updatedProject({ id: 'proj-1', url: 'https://linear.app/x/project/proj-1' }),
      );
    const epic: CanonicalItem = {
      localId: 'local-1',
      level: 'epic',
      title: 'Updated epic',
      description: 'New body.',
    };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.updateItem('proj-1', epic);

    expect(lastQuery(request)).toContain('projectUpdate');
    expect(lastId(request)).toBe('proj-1');
    expect(lastInput(request)).toEqual({ name: 'Updated epic', description: 'New body.' });
  });

  it('surfaces an auth failure on projectCreate with team context and a write-access hint', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        new LinearRequestError({ code: 'auth', retryable: false, message: 'Unauthorized' }),
      );
    const epic: CanonicalItem = { localId: 'local-1', level: 'epic', title: 'An epic' };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const error = await adapter.createItem(epic).then(
      () => {
        throw new Error('expected createItem to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(LinearRequestError);
    expect((error as LinearRequestError).info.code).toBe('auth');
    expect((error as LinearRequestError).info.message).toContain('team-1');
    expect((error as LinearRequestError).info.message).toContain('Unauthorized');
    expect((error as LinearRequestError).info.message).toMatch(/write access/i);
  });

  it('rejects with a bad_request when projectCreate reports a soft failure', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ projectCreate: { success: false, project: null } });
    const epic: CanonicalItem = { localId: 'local-1', level: 'epic', title: 'An epic' };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const error = await adapter.createItem(epic).then(
      () => {
        throw new Error('expected createItem to reject');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(LinearRequestError);
    expect((error as LinearRequestError).info.code).toBe('bad_request');
    expect((error as LinearRequestError).info.retryable).toBe(false);
  });

  it('rejects a malformed project success whose project lacks an id or url', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ projectCreate: { success: true, project: { id: '', url: '' } } });
    const epic: CanonicalItem = { localId: 'local-1', level: 'epic', title: 'An epic' };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    const error = await adapter.createItem(epic).then(
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

/**
 * TER-22: label syncing (create-if-missing). A non-epic item's free-form `tags`
 * are resolved to Linear label ids at create time: existing labels are reused,
 * missing ones are created via `issueLabelCreate`, and the resolved ids land in
 * the `issueCreate` input's `labelIds`. The index is seeded once per adapter
 * instance from `getMetadata().labels`, so a new label is created at most once
 * across a push. Because the path now touches three operations (`team(...)` for
 * metadata, `issueLabelCreate`, `issueCreate`), the faked `request` branches on
 * the query string rather than returning a single envelope. The injected
 * transport is faked with a `vi.fn()` `request`, so the suite touches no network.
 */
describe('LinearAdapter — TER-22: label syncing', () => {
  /** Fakes the GraphQL transport with a single recordable `request` method. */
  function fakeClientWith(request: ReturnType<typeof vi.fn>): LinearGraphQLClient {
    return { request } as unknown as LinearGraphQLClient;
  }

  /** All `request` calls whose query contains `op`, newest last. */
  function callsFor(request: ReturnType<typeof vi.fn>, op: string) {
    return request.mock.calls.filter((call) => (call[0] as string).includes(op));
  }

  /** The single (or last) `input` variable from the calls matching `op`. */
  function inputFor(
    request: ReturnType<typeof vi.fn>,
    op: string,
  ): Record<string, unknown> {
    const call = callsFor(request, op).at(-1);
    return (call?.[1] as { input: Record<string, unknown> }).input;
  }

  /** A `team(...)` metadata envelope carrying the given label nodes. */
  function metadataWithLabels(
    labels: Array<{ id: string; name: string; isGroup?: boolean }>,
  ) {
    return {
      team: {
        id: 'team-1',
        name: 'Eng',
        states: { nodes: [] },
        labels: {
          nodes: labels.map((l) => ({
            id: l.id,
            name: l.name,
            isGroup: l.isGroup ?? false,
            parent: null,
          })),
        },
      },
    };
  }

  /**
   * Builds a branching `request` fake: metadata for the `labels` query, a created
   * label for `issueLabelCreate` (id = `lbl-<n>`, incrementing), and a created
   * issue for `issueCreate`. The created-label id is recorded so a test can also
   * assert which generated id landed on the issue.
   */
  function branchingRequest(
    existingLabels: Array<{ id: string; name: string; isGroup?: boolean }>,
  ) {
    let nextLabel = 0;
    const createdLabelIds: string[] = [];
    const request = vi.fn().mockImplementation((query: string) => {
      if (query.includes('issueLabelCreate')) {
        const id = `lbl-${++nextLabel}`;
        createdLabelIds.push(id);
        return Promise.resolve({
          issueLabelCreate: { success: true, issueLabel: { id, name: 'created' } },
        });
      }
      if (query.includes('issueCreate')) {
        return Promise.resolve({
          issueCreate: {
            success: true,
            issue: { id: 'iss-1', url: 'https://linear.app/x/issue/iss-1' },
          },
        });
      }
      // Default: the metadata `team(...) { ... labels ... }` query.
      return Promise.resolve(metadataWithLabels(existingLabels));
    });
    return { request, createdLabelIds };
  }

  it('reuses an existing label without creating it (no issueLabelCreate)', async () => {
    const { request } = branchingRequest([{ id: 'lbl-bug', name: 'bug' }]);
    const item: CanonicalItem = {
      localId: 'local-1',
      level: 'story',
      title: 'A story',
      tags: ['bug'],
    };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.createItem(item);

    expect(callsFor(request, 'issueLabelCreate')).toHaveLength(0);
    expect(inputFor(request, 'issueCreate')['labelIds']).toEqual(['lbl-bug']);
  });

  it('creates a missing label and applies the returned id to the issue', async () => {
    const { request, createdLabelIds } = branchingRequest([]);
    const item: CanonicalItem = {
      localId: 'local-1',
      level: 'story',
      title: 'A story',
      tags: ['spike'],
    };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.createItem(item);

    const createCalls = callsFor(request, 'issueLabelCreate');
    expect(createCalls).toHaveLength(1);
    // The label is created with the tag's name and the configured team.
    expect(inputFor(request, 'issueLabelCreate')).toEqual({
      name: 'spike',
      teamId: 'team-1',
    });
    // The newly minted id lands on the issue.
    expect(inputFor(request, 'issueCreate')['labelIds']).toEqual([createdLabelIds[0]]);
  });

  it('creates a shared new tag exactly once across two createItem calls (AC4 de-dup)', async () => {
    const { request, createdLabelIds } = branchingRequest([]);
    const itemA: CanonicalItem = {
      localId: 'local-1',
      level: 'story',
      title: 'Story A',
      tags: ['shared'],
    };
    const itemB: CanonicalItem = {
      localId: 'local-2',
      level: 'story',
      title: 'Story B',
      tags: ['shared'],
    };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.createItem(itemA);
    await adapter.createItem(itemB);

    // The new label is created exactly once for the whole push...
    expect(callsFor(request, 'issueLabelCreate')).toHaveLength(1);
    // ...and getMetadata (the `labels` query) is seeded exactly once too.
    expect(callsFor(request, 'labels')).toHaveLength(1);
    // Both issues carry the same id.
    const issueCalls = callsFor(request, 'issueCreate');
    expect(issueCalls).toHaveLength(2);
    for (const call of issueCalls) {
      expect((call[1] as { input: Record<string, unknown> }).input['labelIds']).toEqual([
        createdLabelIds[0],
      ]);
    }
  });

  it('merges the configured featureLabelId with the resolved tag ids (de-duped)', async () => {
    const { request, createdLabelIds } = branchingRequest([]);
    const feature: CanonicalItem = {
      localId: 'local-1',
      level: 'feature',
      title: 'A feature',
      tags: ['spike'],
    };
    const adapter = new LinearAdapter(
      { teamId: 'team-1', featureLabelId: 'lbl-feat' },
      fakeClientWith(request),
    );

    await adapter.createItem(feature);

    const labelIds = inputFor(request, 'issueCreate')['labelIds'] as string[];
    expect(labelIds).toContain('lbl-feat');
    expect(labelIds).toContain(createdLabelIds[0]);
    // No duplicates in the union.
    expect(new Set(labelIds).size).toBe(labelIds.length);
  });

  it('excludes isGroup labels when seeding and matches case-insensitively', async () => {
    // `Priority` is a label *group* (must NOT match — gets created instead);
    // `Bug` differs from the tag only by case (must be reused).
    const { request, createdLabelIds } = branchingRequest([
      { id: 'lbl-grp', name: 'Priority', isGroup: true },
      { id: 'lbl-bug', name: 'Bug' },
    ]);
    const item: CanonicalItem = {
      localId: 'local-1',
      level: 'story',
      title: 'A story',
      tags: ['priority', 'BUG'],
    };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.createItem(item);

    // The group name was not treated as a match: exactly one label is created.
    const createCalls = callsFor(request, 'issueLabelCreate');
    expect(createCalls).toHaveLength(1);
    expect((createCalls[0]?.[1] as { input: Record<string, unknown> }).input['name']).toBe(
      'priority',
    );
    // The case-insensitive match reused the existing `Bug` label.
    expect(inputFor(request, 'issueCreate')['labelIds']).toEqual([
      createdLabelIds[0],
      'lbl-bug',
    ]);
  });

  it('does not call getMetadata and leaves labelIds unset for a tag-less item', async () => {
    const { request } = branchingRequest([{ id: 'lbl-bug', name: 'bug' }]);
    const item: CanonicalItem = { localId: 'local-1', level: 'story', title: 'A story' };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.createItem(item);

    // No tags → no metadata seed and no label creation.
    expect(callsFor(request, 'labels')).toHaveLength(0);
    expect(callsFor(request, 'issueLabelCreate')).toHaveLength(0);
    // The issue carries no labelIds (preserves the team-only behavior).
    expect(inputFor(request, 'issueCreate')).not.toHaveProperty('labelIds');
  });

  it('rejects with a non-retryable bad_request when label creation reports a soft failure', async () => {
    const request = vi.fn().mockImplementation((query: string) => {
      if (query.includes('issueLabelCreate')) {
        return Promise.resolve({ issueLabelCreate: { success: false, issueLabel: null } });
      }
      return Promise.resolve(metadataWithLabels([]));
    });
    const item: CanonicalItem = {
      localId: 'local-1',
      level: 'story',
      title: 'A story',
      tags: ['spike'],
    };
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
    // The label name is named in the message so the failure is diagnosable.
    expect((error as LinearRequestError).info.message).toContain('spike');
  });

  it('surfaces an auth failure on label creation with team context and a write-access hint', async () => {
    const request = vi.fn().mockImplementation((query: string) => {
      if (query.includes('issueLabelCreate')) {
        return Promise.reject(
          new LinearRequestError({ code: 'auth', retryable: false, message: 'Unauthorized' }),
        );
      }
      return Promise.resolve(metadataWithLabels([]));
    });
    const item: CanonicalItem = {
      localId: 'local-1',
      level: 'story',
      title: 'A story',
      tags: ['spike'],
    };
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
    expect((error as LinearRequestError).info.message).toContain('team-1');
    expect((error as LinearRequestError).info.message).toContain('Unauthorized');
    expect((error as LinearRequestError).info.message).toMatch(/write access/i);
  });

  it('reuses a label that only exists on the second metadata page (no issueLabelCreate)', async () => {
    // The seed must page through every label: a tag whose normalized name only
    // matches a page-2 label is reused, not recreated, and its id lands on the
    // issue. Page 1 reports a next page; the `LinearTeamLabelsPage` follow-up
    // (it carries a `cursor` variable) returns the page-2 label.
    let nextLabel = 0;
    const request = vi.fn().mockImplementation((query: string) => {
      if (query.includes('issueLabelCreate')) {
        const id = `lbl-${++nextLabel}`;
        return Promise.resolve({
          issueLabelCreate: { success: true, issueLabel: { id, name: 'created' } },
        });
      }
      if (query.includes('issueCreate')) {
        return Promise.resolve({
          issueCreate: {
            success: true,
            issue: { id: 'iss-1', url: 'https://linear.app/x/issue/iss-1' },
          },
        });
      }
      if (query.includes('LinearTeamLabelsPage')) {
        return Promise.resolve({
          team: {
            labels: {
              nodes: [{ id: 'lbl-page2', name: 'Page2', isGroup: false, parent: null }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      // Page 1 of the metadata seed: no matching label, but more pages remain.
      return Promise.resolve({
        team: {
          id: 'team-1',
          name: 'Eng',
          states: { nodes: [] },
          labels: {
            nodes: [{ id: 'lbl-page1', name: 'Page1', isGroup: false, parent: null }],
            pageInfo: { hasNextPage: true, endCursor: 'cur-1' },
          },
        },
      });
    });
    const item: CanonicalItem = {
      localId: 'local-1',
      level: 'story',
      title: 'A story',
      tags: ['page2'],
    };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    await adapter.createItem(item);

    // The page-2 label was seen and reused — no label was created.
    expect(callsFor(request, 'issueLabelCreate')).toHaveLength(0);
    expect(inputFor(request, 'issueCreate')['labelIds']).toEqual(['lbl-page2']);
  });

  it('clears the memo so a later tagged item retries the seed after a transient failure', async () => {
    // The first metadata/seed request rejects once (transient), so the first
    // createItem fails. The memo must be cleared so a second createItem re-issues
    // the seed and succeeds — proving the rejected seed promise was not cached.
    let nextLabel = 0;
    const request = vi.fn().mockImplementation((query: string) => {
      if (query.includes('issueLabelCreate')) {
        const id = `lbl-${++nextLabel}`;
        return Promise.resolve({
          issueLabelCreate: { success: true, issueLabel: { id, name: 'created' } },
        });
      }
      if (query.includes('issueCreate')) {
        return Promise.resolve({
          issueCreate: {
            success: true,
            issue: { id: 'iss-1', url: 'https://linear.app/x/issue/iss-1' },
          },
        });
      }
      return Promise.resolve(metadataWithLabels([{ id: 'lbl-bug', name: 'bug' }]));
    });
    // Reject the FIRST request only (the initial seed), then behave normally.
    request.mockRejectedValueOnce(
      new LinearRequestError({ code: 'rate_limit', retryable: true, message: 'slow down' }),
    );
    const item: CanonicalItem = {
      localId: 'local-1',
      level: 'story',
      title: 'A story',
      tags: ['bug'],
    };
    const adapter = new LinearAdapter({ teamId: 'team-1' }, fakeClientWith(request));

    // First attempt fails because the seed request rejected.
    await expect(adapter.createItem(item)).rejects.toBeInstanceOf(LinearRequestError);

    // Second attempt retries the seed (memo was cleared) and succeeds.
    await adapter.createItem(item);

    // The seed `labels` query was issued on BOTH attempts.
    expect(callsFor(request, 'labels')).toHaveLength(2);
    // The reused label id landed on the issue on the successful attempt.
    expect(inputFor(request, 'issueCreate')['labelIds']).toEqual(['lbl-bug']);
  });
});
