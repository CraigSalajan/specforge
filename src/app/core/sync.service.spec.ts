import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncService, SyncError } from './sync.service';
import { IpcService } from './ipc.service';
import type { SyncExecutePushResult, SyncPushProgressEvent } from '../shared/types';
import type { PushResult, ItemProgressEvent } from '../../../electron/sync/executor';
import type { CanonicalItem } from '../../../electron/sync/canonical-item';

const CONNECTION_ID = 'linear-conn-1';

const PUSH_RESULT: PushResult = {
  results: [{ localId: 'a', decision: 'create', status: 'created' }],
  created: 1,
  updated: 0,
  skipped: 0,
  failed: 0,
};

/**
 * A fake IpcService capturing the `pushId` each execute invoke received and
 * exposing a `fire(evt)` to push a progress event to all subscribers — so a test
 * can simulate the main→renderer stream and assert the demux/cleanup.
 */
function makeIpc() {
  let lastPushId: string | undefined;
  let lastFromItemsPushId: string | undefined;
  const subscribers = new Set<(evt: SyncPushProgressEvent) => void>();
  let unsubscribeCount = 0;

  // Resolve the invoke only when the test asks, so a test can fire progress
  // events while the push is still "in flight".
  let resolveInvoke!: (res: SyncExecutePushResult) => void;
  const invokePromise = (): Promise<SyncExecutePushResult> =>
    new Promise<SyncExecutePushResult>((resolve) => {
      resolveInvoke = resolve;
    });

  return {
    get lastPushId() {
      return lastPushId;
    },
    get lastFromItemsPushId() {
      return lastFromItemsPushId;
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    },
    fire(evt: SyncPushProgressEvent) {
      for (const cb of subscribers) cb(evt);
    },
    settle(res: SyncExecutePushResult) {
      resolveInvoke(res);
    },
    ipc: {
      syncExecutePush: vi.fn((_conn: string, _file: string | undefined, pushId?: string) => {
        lastPushId = pushId;
        return invokePromise();
      }),
      syncExecutePushFromItems: vi.fn((_conn: string, _items: CanonicalItem[], pushId?: string) => {
        lastFromItemsPushId = pushId;
        return invokePromise();
      }),
      onSyncPushProgress: vi.fn((cb: (evt: SyncPushProgressEvent) => void) => {
        subscribers.add(cb);
        return () => {
          subscribers.delete(cb);
          unsubscribeCount += 1;
        };
      }),
    },
  };
}

function setup() {
  const fake = makeIpc();
  TestBed.configureTestingModule({
    providers: [SyncService, { provide: IpcService, useValue: fake.ipc }],
  });
  const service = TestBed.inject(SyncService);
  return { service, fake };
}

describe('SyncService — live push progress (TER-37)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('generates a pushId, threads it into the invoke, and forwards matching events', async () => {
    const { service, fake } = setup();
    const seen: ItemProgressEvent[] = [];

    const pushPromise = service.executePush(CONNECTION_ID, undefined, (ev) => seen.push(ev));
    await Promise.resolve();

    const pushId = fake.lastPushId;
    expect(typeof pushId).toBe('string');
    expect(pushId).toBeTruthy();

    // A matching event is forwarded WITHOUT the transport-level pushId.
    fake.fire({ pushId: pushId!, phase: 'start', localId: 'a', decision: 'create', title: 'A' });
    expect(seen).toEqual([{ phase: 'start', localId: 'a', decision: 'create', title: 'A' }]);

    fake.settle({ ok: true, data: PUSH_RESULT });
    await expect(pushPromise).resolves.toEqual(PUSH_RESULT);
  });

  it('ignores events stamped with a different pushId (demux)', async () => {
    const { service, fake } = setup();
    const seen: ItemProgressEvent[] = [];

    const pushPromise = service.executePush(CONNECTION_ID, undefined, (ev) => seen.push(ev));
    await Promise.resolve();

    // An overlapping push's event must not leak into this listener.
    fake.fire({ pushId: 'some-other-push', phase: 'start', localId: 'a', decision: 'create', title: 'A' });
    expect(seen).toEqual([]);

    fake.settle({ ok: true, data: PUSH_RESULT });
    await pushPromise;
  });

  it('unsubscribes in finally on success', async () => {
    const { service, fake } = setup();
    const pushPromise = service.executePush(CONNECTION_ID, undefined, () => {});
    await Promise.resolve();

    fake.settle({ ok: true, data: PUSH_RESULT });
    await pushPromise;
    expect(fake.unsubscribeCount).toBe(1);
  });

  it('unsubscribes in finally even when the push throws', async () => {
    const { service, fake } = setup();
    const pushPromise = service.executePush(CONNECTION_ID, undefined, () => {});
    await Promise.resolve();

    fake.settle({ ok: false, error: { code: 'server', message: 'boom', retryable: true } });
    await expect(pushPromise).rejects.toBeInstanceOf(SyncError);
    expect(fake.unsubscribeCount).toBe(1);
  });

  it('does NOT subscribe when no onProgress is supplied', async () => {
    const { service, fake } = setup();
    const pushPromise = service.executePush(CONNECTION_ID);
    await Promise.resolve();

    expect(fake.ipc.onSyncPushProgress).not.toHaveBeenCalled();
    // A pushId is still generated and threaded (harmless when nothing subscribes).
    expect(typeof fake.lastPushId).toBe('string');

    fake.settle({ ok: true, data: PUSH_RESULT });
    await pushPromise;
  });

  it('executePushFromItems threads its own pushId and forwards matching events', async () => {
    const { service, fake } = setup();
    const seen: ItemProgressEvent[] = [];
    const items: CanonicalItem[] = [{ localId: 'a', level: 'story', title: 'A' }];

    const pushPromise = service.executePushFromItems(CONNECTION_ID, items, (ev) => seen.push(ev));
    await Promise.resolve();

    const pushId = fake.lastFromItemsPushId;
    expect(pushId).toBeTruthy();
    fake.fire({ pushId: pushId!, phase: 'done', localId: 'a', decision: 'create', title: 'A', result: PUSH_RESULT.results[0] });
    expect(seen).toEqual([
      { phase: 'done', localId: 'a', decision: 'create', title: 'A', result: PUSH_RESULT.results[0] },
    ]);

    fake.settle({ ok: true, data: PUSH_RESULT });
    await pushPromise;
  });
});
