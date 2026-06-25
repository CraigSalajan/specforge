import { describe, expect, it } from 'vitest';
import {
  connectionToLinearConfig,
  isConnection,
  makeConnectionId,
  parseConnectionsMap,
  type Connection,
  type LinearConnection,
} from '../../../electron/sync/connection';

/** Minimal LinearConnection factory keeping tests terse. */
function linearConnection(partial: Partial<LinearConnection> = {}): LinearConnection {
  return {
    connectionId: 'linear-0000000000000000',
    provider: 'linear',
    enabled: true,
    authMode: 'pat',
    teamId: 'team-1',
    ...partial,
  };
}

describe('makeConnectionId', () => {
  it('is deterministic: identical inputs produce identical ids', () => {
    const input = { vaultPath: 'C:/Vault', provider: 'linear' as const, projectId: 'p1' };
    expect(makeConnectionId(input)).toBe(makeConnectionId(input));
  });

  it('differs when the projectId differs', () => {
    const a = makeConnectionId({ vaultPath: 'C:/Vault', provider: 'linear', projectId: 'p1' });
    const b = makeConnectionId({ vaultPath: 'C:/Vault', provider: 'linear', projectId: 'p2' });
    expect(a).not.toBe(b);
  });

  it('treats a missing projectId distinctly from a present one', () => {
    const withProject = makeConnectionId({
      vaultPath: 'C:/Vault',
      provider: 'linear',
      projectId: 'p1',
    });
    const withoutProject = makeConnectionId({ vaultPath: 'C:/Vault', provider: 'linear' });
    expect(withProject).not.toBe(withoutProject);
  });

  it('differs when the teamId differs (same vault, provider, no project)', () => {
    const a = makeConnectionId({ vaultPath: 'C:/Vault', provider: 'linear', teamId: 'team-1' });
    const b = makeConnectionId({ vaultPath: 'C:/Vault', provider: 'linear', teamId: 'team-2' });
    expect(a).not.toBe(b);
  });

  it('normalizes vault-path case and separators to the same id', () => {
    // `C:\Vault` and `c:/vault` are the same vault (normalized lowercase,
    // forward-slash — the ui.collapsedFolders precedent), so the ids must match.
    const windows = makeConnectionId({ vaultPath: 'C:\\Vault', provider: 'linear', projectId: 'p1' });
    const posix = makeConnectionId({ vaultPath: 'c:/vault', provider: 'linear', projectId: 'p1' });
    expect(windows).toBe(posix);
  });

  it('prefixes the id with the provider name', () => {
    const id = makeConnectionId({ vaultPath: 'C:/Vault', provider: 'linear', projectId: 'p1' });
    expect(id.startsWith('linear-')).toBe(true);
  });
});

describe('isConnection', () => {
  it('accepts a well-formed linear connection (with and without optionals)', () => {
    expect(isConnection(linearConnection())).toBe(true);
    expect(
      isConnection(linearConnection({ projectId: 'p1', featureLabelId: 'l1' })),
    ).toBe(true);
  });

  it('rejects non-object values', () => {
    expect(isConnection(null)).toBe(false);
    expect(isConnection(undefined)).toBe(false);
    expect(isConnection('linear')).toBe(false);
    expect(isConnection(42)).toBe(false);
    expect(isConnection([linearConnection()])).toBe(false);
  });

  it('rejects missing or wrong-typed required fields', () => {
    const base = linearConnection();
    expect(isConnection({ ...base, connectionId: 123 })).toBe(false);
    expect(isConnection({ ...base, provider: 'jira' })).toBe(false);
    expect(isConnection({ ...base, enabled: 'yes' })).toBe(false);
    expect(isConnection({ ...base, authMode: 'sso' })).toBe(false);
    const { teamId: _teamId, ...noTeam } = base;
    expect(isConnection(noTeam)).toBe(false);
  });

  it('rejects optional fields that are present but not strings (incl. null)', () => {
    // A persisted `null` (e.g. from a serializer that emitted null instead of
    // omitting) is not a valid optional string and must be rejected, not coerced.
    expect(isConnection({ ...linearConnection(), projectId: null })).toBe(false);
    expect(isConnection({ ...linearConnection(), featureLabelId: 42 })).toBe(false);
  });
});

describe('connectionToLinearConfig', () => {
  it('always maps the teamId', () => {
    const config = connectionToLinearConfig(linearConnection({ teamId: 'team-xyz' }));
    expect(config.teamId).toBe('team-xyz');
  });

  it('includes projectId and featureLabelId when present', () => {
    const config = connectionToLinearConfig(
      linearConnection({ projectId: 'proj-1', featureLabelId: 'label-1' }),
    );
    expect(config).toEqual({ teamId: 'team-1', projectId: 'proj-1', featureLabelId: 'label-1' });
  });

  it('omits absent optional fields (no undefined keys)', () => {
    const config = connectionToLinearConfig(linearConnection());
    expect(config).toEqual({ teamId: 'team-1' });
    expect('projectId' in config).toBe(false);
    expect('featureLabelId' in config).toBe(false);
  });
});

describe('parseConnectionsMap', () => {
  it('round-trips a valid map', () => {
    const conn = linearConnection();
    const map: Record<string, Connection[]> = { 'C:/Vault': [conn] };
    expect(parseConnectionsMap(map)).toEqual(map);
  });

  it('drops malformed connections within a vault entry', () => {
    const valid = linearConnection();
    const map = {
      'C:/Vault': [
        valid,
        { connectionId: 'bad', provider: 'linear', enabled: true, authMode: 'pat' }, // no teamId
        { provider: 'jira' }, // unrecognized provider
        42,
        null,
      ],
    };
    expect(parseConnectionsMap(map)).toEqual({ 'C:/Vault': [valid] });
  });

  it('returns {} for non-object or array input', () => {
    expect(parseConnectionsMap(null)).toEqual({});
    expect(parseConnectionsMap(undefined)).toEqual({});
    expect(parseConnectionsMap('nope')).toEqual({});
    expect(parseConnectionsMap(42)).toEqual({});
    expect(parseConnectionsMap([linearConnection()])).toEqual({});
  });

  it('drops a vault entry whose connections are all invalid', () => {
    const map = {
      'C:/Good': [linearConnection()],
      'C:/Bad': [{ provider: 'linear' }, 'not-a-connection'],
      'C:/NotArray': { nested: true },
    };
    expect(parseConnectionsMap(map)).toEqual({ 'C:/Good': [linearConnection()] });
  });

  it('survives the JSON.stringify → JSON.parse persistence round-trip', () => {
    // Mirrors the real settings.service.ts path: the map is stringified into the
    // `pm.connections` setting and re-parsed on hydrate. `JSON.stringify` drops
    // explicit-`undefined` optionals, so the rehydrated value must match the
    // optional-less shape exactly (no `undefined` keys leaking back in).
    const map: Record<string, Connection[]> = {
      'C:/Vault': [
        linearConnection({ connectionId: 'linear-aaaa', projectId: undefined }),
        linearConnection({ connectionId: 'linear-bbbb', projectId: 'p1', featureLabelId: 'l1' }),
      ],
    };
    const rehydrated = parseConnectionsMap(JSON.parse(JSON.stringify(map)));
    expect(rehydrated).toEqual({
      'C:/Vault': [
        { connectionId: 'linear-aaaa', provider: 'linear', enabled: true, authMode: 'pat', teamId: 'team-1' },
        {
          connectionId: 'linear-bbbb',
          provider: 'linear',
          enabled: true,
          authMode: 'pat',
          teamId: 'team-1',
          projectId: 'p1',
          featureLabelId: 'l1',
        },
      ],
    });
    expect('projectId' in rehydrated['C:/Vault'][0]).toBe(false);
  });
});
