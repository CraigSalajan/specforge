import { describe, expect, it } from 'vitest';
import {
  LEVEL_MAPPINGS,
  resolveLevel,
} from '../../../electron/sync/level-mapping';
import type { AdapterName } from '../../../electron/sync/adapter';
import type { CanonicalLevel } from '../../../electron/sync/canonical-item';

const PROVIDERS: AdapterName[] = ['ado', 'linear', 'jira', 'github'];
const LEVELS: CanonicalLevel[] = ['epic', 'feature', 'story', 'criterion'];

describe('resolveLevel', () => {
  it('maps a Linear epic to a Project work item (AC #3)', () => {
    expect(resolveLevel('linear', 'epic')).toEqual({
      nativeType: 'Project',
      representation: 'item',
    });
  });

  it('folds criteria inline for flatter hierarchies', () => {
    expect(resolveLevel('linear', 'criterion').representation).toBe('inline');
    expect(resolveLevel('github', 'criterion').representation).toBe('inline');
  });

  it('creates criteria as their own items where the provider supports it', () => {
    expect(resolveLevel('ado', 'criterion').representation).toBe('item');
    expect(resolveLevel('jira', 'criterion').representation).toBe('item');
  });

  it('resolves each provider native epic type', () => {
    expect(resolveLevel('ado', 'epic').nativeType).toBe('Epic');
    expect(resolveLevel('linear', 'epic').nativeType).toBe('Project');
    expect(resolveLevel('jira', 'epic').nativeType).toBe('Epic');
    expect(resolveLevel('github', 'epic').nativeType).toBe('Milestone');
  });

  it('defines a complete mapping for every provider and level', () => {
    for (const provider of PROVIDERS) {
      for (const level of LEVELS) {
        const native = resolveLevel(provider, level);
        expect(native).toBeDefined();
        expect(typeof native.nativeType).toBe('string');
        expect(native.nativeType.length).toBeGreaterThan(0);
        expect(['item', 'inline']).toContain(native.representation);
      }
    }
  });
});

describe('LEVEL_MAPPINGS', () => {
  it('covers all four providers', () => {
    expect(Object.keys(LEVEL_MAPPINGS).sort()).toEqual(
      [...PROVIDERS].sort(),
    );
  });
});
