import { describe, expect, it } from 'vitest';
import {
  applyReconcile,
  buildReconcilePlan,
  computeRemoteHash,
  type ReconcileApplyDeps,
  type ReconcileInput,
  type ResolvedReconcileEntry,
} from '../../../electron/sync/reconcile';
import type { RemoteItemState } from '../../../electron/sync/adapter';
import type { SyncLink } from '../../../electron/db/repositories/sync-links.repo';

/**
 * Unit tests for the pull/reconcile core (TER-23). The module is pure, DB-free,
 * and network-free: remote state and the final resolution are supplied as data,
 * and the apply path persists through an injected `writePullState`. The suite
 * therefore touches no network, no DB, and no Electron — it runs entirely under
 * the Vitest/jsdom environment with fakes and an injected clock.
 */

const CONNECTION_ID = 'conn-1';
const FIXED_NOW = '2026-06-24T12:00:00.000Z';

/** Baseline/push timestamp used as the "before" anchor in most cases. */
const BASELINE = '2026-06-01T00:00:00.000Z';
/** A timestamp strictly after BASELINE — a real remote change. */
const NEWER = '2026-06-10T00:00:00.000Z';
/** A timestamp strictly before BASELINE — never a remote change. */
const OLDER = '2026-05-01T00:00:00.000Z';

/**
 * Minimal SyncLink factory. Defaults represent a freshly-pushed, never-pulled
 * link (no pull state); override `externalUpdatedAt`/`lastPulledHash` to exercise
 * the pull baseline and hash-demotion paths.
 */
function link(partial: Partial<SyncLink> & Pick<SyncLink, 'specItemId'>): SyncLink {
  return {
    connectionId: CONNECTION_ID,
    externalId: `EXT-${partial.specItemId}`,
    externalUrl: `https://example.test/${partial.specItemId}`,
    lastPushedHash: `pushed-${partial.specItemId}`,
    lastPushedAt: BASELINE,
    ...partial,
  };
}

/** Minimal RemoteItemState factory. */
function remote(partial: Partial<RemoteItemState> = {}): RemoteItemState {
  return {
    externalId: 'EXT-a',
    externalUrl: 'https://example.test/a',
    updatedAt: NEWER,
    title: 'Remote title',
    ...partial,
  };
}

describe('computeRemoteHash', () => {
  it('is deterministic for the same content', () => {
    const r = remote({ title: 'T', description: 'D' });
    expect(computeRemoteHash(r)).toBe(computeRemoteHash({ ...r }));
  });

  it('changes when title or description changes', () => {
    const base = computeRemoteHash(remote({ title: 'T', description: 'D' }));
    expect(computeRemoteHash(remote({ title: 'T2', description: 'D' }))).not.toBe(base);
    expect(computeRemoteHash(remote({ title: 'T', description: 'D2' }))).not.toBe(base);
  });

  it('ignores fields outside the content projection (id/url/updatedAt)', () => {
    const a = remote({ title: 'T', externalId: 'x', externalUrl: 'ux', updatedAt: NEWER });
    const b = remote({ title: 'T', externalId: 'y', externalUrl: 'uy', updatedAt: OLDER });
    expect(computeRemoteHash(a)).toBe(computeRemoteHash(b));
  });

  it('treats an absent description the same as an explicitly undefined one', () => {
    const absent = remote({ title: 'T' });
    const explicitUndefined = remote({ title: 'T', description: undefined });
    expect(computeRemoteHash(absent)).toBe(computeRemoteHash(explicitUndefined));
  });

  it('distinguishes an absent description from an empty-string description', () => {
    // Designed asymmetry: undefined is omitted from the projection, '' is present.
    expect(computeRemoteHash(remote({ title: 'T' }))).not.toBe(
      computeRemoteHash(remote({ title: 'T', description: '' })),
    );
  });
});

describe('buildReconcilePlan — classification matrix', () => {
  it('classifies unchanged when neither side moved', () => {
    const input: ReconcileInput = {
      link: link({ specItemId: 'a' }),
      remote: remote({ updatedAt: OLDER }), // not after baseline ⇒ remote unchanged
      localHash: 'pushed-a', // equals lastPushedHash ⇒ local unchanged
    };

    const { entries } = buildReconcilePlan([input]);

    expect(entries[0].classification).toBe('unchanged');
    expect(entries[0].proposedResolution).toBe('none');
    expect(entries[0].remoteChanged).toBe(false);
    expect(entries[0].localChanged).toBe(false);
    expect(entries[0].localKnown).toBe(true);
    expect(entries[0].remoteUpdatedAt).toBe(OLDER);
  });

  it('classifies remote-only (auto-adopt) when only the remote moved and local is known-unchanged', () => {
    const input: ReconcileInput = {
      link: link({ specItemId: 'a' }),
      remote: remote({ updatedAt: NEWER }),
      localHash: 'pushed-a', // unchanged
    };

    const { entries } = buildReconcilePlan([input]);

    expect(entries[0].classification).toBe('remote-only');
    expect(entries[0].proposedResolution).toBe('adopt-remote');
    expect(entries[0].remoteChanged).toBe(true);
    expect(entries[0].localChanged).toBe(false);
  });

  it('classifies local-only (keep-local) when only the local item changed', () => {
    const input: ReconcileInput = {
      link: link({ specItemId: 'a' }),
      remote: remote({ updatedAt: OLDER }), // remote unchanged
      localHash: 'changed-locally',
    };

    const { entries } = buildReconcilePlan([input]);

    expect(entries[0].classification).toBe('local-only');
    expect(entries[0].proposedResolution).toBe('keep-local');
    expect(entries[0].remoteChanged).toBe(false);
    expect(entries[0].localChanged).toBe(true);
  });

  it('classifies conflict when both sides changed', () => {
    const input: ReconcileInput = {
      link: link({ specItemId: 'a' }),
      remote: remote({ updatedAt: NEWER }),
      localHash: 'changed-locally',
    };

    const { entries } = buildReconcilePlan([input]);

    expect(entries[0].classification).toBe('conflict');
    expect(entries[0].proposedResolution).toBe('needs-user');
    expect(entries[0].remoteChanged).toBe(true);
    expect(entries[0].localChanged).toBe(true);
  });

  it('classifies conflict when the remote changed but local state is unknown (safety rule)', () => {
    const input: ReconcileInput = {
      link: link({ specItemId: 'a' }),
      remote: remote({ updatedAt: NEWER }),
      localHash: null, // unknown local ⇒ cannot prove safe to overwrite
    };

    const { entries } = buildReconcilePlan([input]);

    expect(entries[0].classification).toBe('conflict');
    expect(entries[0].proposedResolution).toBe('needs-user');
    expect(entries[0].localKnown).toBe(false);
    expect(entries[0].remoteChanged).toBe(true);
  });

  it('classifies unchanged when nothing moved even with unknown local state', () => {
    const input: ReconcileInput = {
      link: link({ specItemId: 'a' }),
      remote: remote({ updatedAt: OLDER }),
      localHash: null,
    };

    const { entries } = buildReconcilePlan([input]);

    expect(entries[0].classification).toBe('unchanged');
    expect(entries[0].proposedResolution).toBe('none');
  });

  it('classifies remote-missing (needs-user, never auto-delete) when the remote no longer exists', () => {
    const input: ReconcileInput = {
      link: link({ specItemId: 'a' }),
      remote: null,
      localHash: 'changed-locally',
    };

    const { entries } = buildReconcilePlan([input]);

    expect(entries[0].classification).toBe('remote-missing');
    expect(entries[0].proposedResolution).toBe('needs-user');
    expect(entries[0].remoteChanged).toBe(false);
    expect(entries[0].remoteUpdatedAt).toBeUndefined();
    // The local-change signal is still surfaced for the user.
    expect(entries[0].localChanged).toBe(true);
  });

  it('throws when the remote identity does not match the link', () => {
    const input: ReconcileInput = {
      link: link({ specItemId: 'a' }), // externalId EXT-a
      remote: remote({ externalId: 'EXT-other' }),
      localHash: 'pushed-a',
    };

    expect(() => buildReconcilePlan([input])).toThrow(/does not match/i);
  });

  it('throws when the remote updatedAt is not a valid date', () => {
    const input: ReconcileInput = {
      link: link({ specItemId: 'a' }),
      remote: remote({ updatedAt: 'not-a-date' }),
      localHash: 'pushed-a',
    };

    expect(() => buildReconcilePlan([input])).toThrow(/invalid remote\.updatedAt/i);
  });
});

describe('buildReconcilePlan — lastPulledHash suppression', () => {
  it('demotes a content-identical updatedAt bump to unchanged', () => {
    const r = remote({ title: 'Same', description: 'Body', updatedAt: NEWER });
    const input: ReconcileInput = {
      // The stored pull hash matches the remote content, so the newer timestamp
      // is a metadata-only bump and must NOT count as a remote change.
      link: link({ specItemId: 'a', lastPulledHash: computeRemoteHash(r) }),
      remote: r,
      localHash: 'pushed-a', // unchanged
    };

    const { entries } = buildReconcilePlan([input]);

    expect(entries[0].remoteChanged).toBe(false);
    expect(entries[0].classification).toBe('unchanged');
  });

  it('still detects a real remote change when the content hash differs from lastPulledHash', () => {
    const input: ReconcileInput = {
      link: link({ specItemId: 'a', lastPulledHash: 'hash-of-old-content' }),
      remote: remote({ title: 'New title', updatedAt: NEWER }),
      localHash: 'pushed-a',
    };

    const { entries } = buildReconcilePlan([input]);

    expect(entries[0].remoteChanged).toBe(true);
    expect(entries[0].classification).toBe('remote-only');
  });

  it('does not demote when there is no stored lastPulledHash', () => {
    const input: ReconcileInput = {
      link: link({ specItemId: 'a' }), // no lastPulledHash
      remote: remote({ updatedAt: NEWER }),
      localHash: 'pushed-a',
    };

    const { entries } = buildReconcilePlan([input]);

    expect(entries[0].remoteChanged).toBe(true);
  });
});

describe('buildReconcilePlan — baseline selection', () => {
  it('prefers externalUpdatedAt over lastPushedAt as the comparison baseline', () => {
    // lastPushedAt is OLDER and externalUpdatedAt is NEWER. A remote stamped at
    // BASELINE (between them) is AFTER lastPushedAt but NOT after externalUpdatedAt,
    // so using externalUpdatedAt as the baseline yields "no remote change".
    const input: ReconcileInput = {
      link: link({ specItemId: 'a', lastPushedAt: OLDER, externalUpdatedAt: NEWER }),
      remote: remote({ updatedAt: BASELINE }),
      localHash: 'pushed-a',
    };

    const { entries } = buildReconcilePlan([input]);

    expect(entries[0].baselineAt).toBe(NEWER);
    expect(entries[0].remoteChanged).toBe(false);
    expect(entries[0].classification).toBe('unchanged');
  });

  it('falls back to lastPushedAt when externalUpdatedAt is absent', () => {
    const input: ReconcileInput = {
      link: link({ specItemId: 'a', lastPushedAt: BASELINE }),
      remote: remote({ updatedAt: NEWER }),
      localHash: 'pushed-a',
    };

    const { entries } = buildReconcilePlan([input]);

    expect(entries[0].baselineAt).toBe(BASELINE);
    expect(entries[0].remoteChanged).toBe(true);
  });

  it('treats an identical baseline timestamp as no remote change (strict >)', () => {
    const input: ReconcileInput = {
      link: link({ specItemId: 'a', lastPushedAt: BASELINE }),
      remote: remote({ updatedAt: BASELINE }),
      localHash: 'pushed-a',
    };

    const { entries } = buildReconcilePlan([input]);

    expect(entries[0].remoteChanged).toBe(false);
  });
});

describe('buildReconcilePlan — counts & ordering', () => {
  it('tallies counts across a mixed batch and preserves input order', () => {
    const inputs: ReconcileInput[] = [
      // unchanged
      { link: link({ specItemId: 'u' }), remote: remote({ updatedAt: OLDER, externalId: 'EXT-u' }), localHash: 'pushed-u' },
      // remote-only
      { link: link({ specItemId: 'r' }), remote: remote({ updatedAt: NEWER, externalId: 'EXT-r' }), localHash: 'pushed-r' },
      // local-only
      { link: link({ specItemId: 'l' }), remote: remote({ updatedAt: OLDER, externalId: 'EXT-l' }), localHash: 'edited' },
      // conflict (both changed)
      { link: link({ specItemId: 'c' }), remote: remote({ updatedAt: NEWER, externalId: 'EXT-c' }), localHash: 'edited' },
      // remote-missing
      { link: link({ specItemId: 'm' }), remote: null, localHash: 'pushed-m' },
    ];

    const { entries, counts } = buildReconcilePlan(inputs);

    expect(entries.map((e) => e.specItemId)).toEqual(['u', 'r', 'l', 'c', 'm']);
    expect(counts).toEqual({
      unchanged: 1,
      remoteOnly: 1,
      localOnly: 1,
      conflict: 1,
      remoteMissing: 1,
      total: 5,
    });
  });

  it('returns an empty plan for no inputs', () => {
    const { entries, counts } = buildReconcilePlan([]);
    expect(entries).toEqual([]);
    expect(counts).toEqual({
      unchanged: 0,
      remoteOnly: 0,
      localOnly: 0,
      conflict: 0,
      remoteMissing: 0,
      total: 0,
    });
  });
});

describe('applyReconcile', () => {
  /** Deps with an in-memory writePullState capture and a fixed clock. */
  function fakeDeps(): {
    deps: ReconcileApplyDeps;
    writes: Array<Parameters<ReconcileApplyDeps['writePullState']>[0]>;
  } {
    const writes: Array<Parameters<ReconcileApplyDeps['writePullState']>[0]> = [];
    return {
      writes,
      deps: { writePullState: (u) => writes.push(u), now: () => FIXED_NOW },
    };
  }

  /** A resolved entry from a link/remote/resolution, deriving the entry's ids. */
  function resolved(
    specItemId: string,
    remoteState: RemoteItemState | null,
    resolution: ResolvedReconcileEntry['resolution'],
  ): ResolvedReconcileEntry {
    const l = link({ specItemId });
    return {
      entry: {
        specItemId: l.specItemId,
        connectionId: l.connectionId,
        externalId: l.externalId,
        externalUrl: l.externalUrl,
        classification: 'remote-only',
        proposedResolution: 'adopt-remote',
        baselineAt: BASELINE,
        remoteChanged: true,
        localChanged: false,
        localKnown: true,
      },
      remote: remoteState ? { ...remoteState, externalId: l.externalId } : null,
      resolution,
    };
  }

  it('adopt-remote writes the advanced pull baseline with the injected now and remote hash', () => {
    const { deps, writes } = fakeDeps();
    const r = remote({ updatedAt: NEWER, title: 'Adopted', description: 'Body' });

    const result = applyReconcile([resolved('a', r, 'adopt-remote')], deps);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      specItemId: 'a',
      connectionId: CONNECTION_ID,
      externalId: 'EXT-a',
      externalUpdatedAt: NEWER,
      lastPulledAt: FIXED_NOW,
      lastPulledHash: computeRemoteHash(r),
    });
    expect(result.results[0].status).toBe('adopted');
    expect(result.adopted).toBe(1);
  });

  it('adopt-remote with a null remote fails and writes nothing', () => {
    const { deps, writes } = fakeDeps();

    const result = applyReconcile([resolved('a', null, 'adopt-remote')], deps);

    expect(writes).toHaveLength(0);
    expect(result.results[0].status).toBe('failed');
    expect(result.results[0].error).toMatch(/no remote state/i);
    expect(result.failed).toBe(1);
  });

  it('keep-local is a no-op on the link (no writePullState)', () => {
    const { deps, writes } = fakeDeps();

    const result = applyReconcile([resolved('a', remote(), 'keep-local')], deps);

    expect(writes).toHaveLength(0);
    expect(result.results[0].status).toBe('kept-local');
    expect(result.keptLocal).toBe(1);
  });

  it('skip is a no-op (no writePullState)', () => {
    const { deps, writes } = fakeDeps();

    const result = applyReconcile([resolved('a', remote(), 'skip')], deps);

    expect(writes).toHaveLength(0);
    expect(result.results[0].status).toBe('skipped');
    expect(result.skipped).toBe(1);
  });

  it('defaults now() to an ISO timestamp when not injected', () => {
    const writes: Array<Parameters<ReconcileApplyDeps['writePullState']>[0]> = [];
    const r = remote({ updatedAt: NEWER });

    applyReconcile([resolved('a', r, 'adopt-remote')], { writePullState: (u) => writes.push(u) });

    expect(writes[0].lastPulledAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('one failing entry does not abort the rest and tallies are correct', () => {
    const { deps, writes } = fakeDeps();
    // Make writePullState throw for one specItemId to exercise the per-entry catch.
    const throwingDeps: ReconcileApplyDeps = {
      now: () => FIXED_NOW,
      writePullState: (u) => {
        if (u.specItemId === 'boom') throw new Error('db write failed');
        deps.writePullState(u);
      },
    };
    const r = remote({ updatedAt: NEWER });

    const result = applyReconcile(
      [
        resolved('ok1', r, 'adopt-remote'),
        resolved('boom', r, 'adopt-remote'),
        resolved('ok2', r, 'adopt-remote'),
        resolved('kept', r, 'keep-local'),
        resolved('skip', r, 'skip'),
      ],
      throwingDeps,
    );

    // The two healthy adopts were written; the throwing one did not abort them.
    expect(writes.map((w) => w.specItemId)).toEqual(['ok1', 'ok2']);
    expect(result.results.map((r) => r.status)).toEqual([
      'adopted',
      'failed',
      'adopted',
      'kept-local',
      'skipped',
    ]);
    expect(result).toMatchObject({ adopted: 2, keptLocal: 1, skipped: 1, failed: 1 });
    expect(result.results[1].error).toMatch(/db write failed/);
  });

  it('returns an empty result for no resolved entries', () => {
    const { deps } = fakeDeps();
    const result = applyReconcile([], deps);
    expect(result).toEqual({ results: [], adopted: 0, keptLocal: 0, skipped: 0, failed: 0 });
  });

  it('adopt-remote whose remote identity does not match the entry fails and writes nothing', () => {
    const { deps, writes } = fakeDeps();
    const r = remote({ updatedAt: NEWER, externalId: 'EXT-other' });
    const mismatched: ResolvedReconcileEntry = {
      entry: {
        specItemId: 'a',
        connectionId: CONNECTION_ID,
        externalId: 'EXT-a',
        externalUrl: 'https://example.test/a',
        classification: 'remote-only',
        proposedResolution: 'adopt-remote',
        baselineAt: BASELINE,
        remoteChanged: true,
        localChanged: false,
        localKnown: true,
      },
      remote: r,
      resolution: 'adopt-remote',
    };

    const result = applyReconcile([mismatched], deps);

    expect(writes).toHaveLength(0);
    expect(result.results[0].status).toBe('failed');
    expect(result.results[0].error).toMatch(/does not match/i);
    expect(result.failed).toBe(1);
  });
});
