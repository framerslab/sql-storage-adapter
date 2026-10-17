import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncOutcome } from '../../src/features/sync/mutations/client';
import { SyncLoop } from '../../src/features/sync/mutations/loop';
import { SyncUnavailable } from '../../src/features/sync/mutations/transport';

/** A client that records its calls and answers what the test sets. */
function fakeClient() {
  const calls: string[] = [];
  const client = {
    calls,
    fail: false,
    pushAnswer: { kind: 'idle' } as SyncOutcome,
    pullAnswer: { kind: 'applied' } as SyncOutcome,
    async push(): Promise<SyncOutcome> {
      calls.push('push');
      if (client.fail) throw new SyncUnavailable(new Error('offline'));
      return client.pushAnswer;
    },
    async pull(): Promise<SyncOutcome> {
      calls.push('pull');
      if (client.fail) throw new SyncUnavailable(new Error('offline'));
      return client.pullAnswer;
    },
  };
  return client;
}

describe('the sync loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushes and pulls at once on start, then pulls every 60 seconds while visible and never while hidden', async () => {
    const client = fakeClient();
    let visible = true;
    const loop = new SyncLoop({ client, visible: () => visible });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls).toEqual(['push', 'pull']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.calls).toEqual(['push', 'pull', 'push', 'pull']);
    visible = false;
    await vi.advanceTimersByTimeAsync(60_000);
    const hidden = client.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.calls.length).toBe(hidden);
    visible = true;
    loop.kick('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls.length).toBe(hidden + 2);
    loop.stop();
  });

  it('retries after 2 seconds, doubling to 300, and goes back to its pace once a cycle succeeds', async () => {
    const client = fakeClient();
    client.fail = true;
    const loop = new SyncLoop({ client, visible: () => true });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    const waits: number[] = [];
    let last = client.calls.length;
    let elapsed = 0;
    while (waits.length < 9) {
      await vi.advanceTimersByTimeAsync(1000);
      elapsed += 1000;
      if (client.calls.length !== last) {
        waits.push(elapsed);
        elapsed = 0;
        last = client.calls.length;
      }
    }
    expect(waits).toEqual([2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000]);
    client.fail = false;
    await vi.advanceTimersByTimeAsync(300_000);
    const settled = client.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.calls.length).toBe(settled + 2);
    loop.stop();
  });

  it('pushes at once after a save, waits as a rate refusal asks, and runs one cycle at a time', async () => {
    const client = fakeClient();
    const loop = new SyncLoop({ client, visible: () => true });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    client.calls.length = 0;
    loop.kick('save');
    loop.kick('save');
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls).toEqual(['push', 'pull', 'push', 'pull']);
    client.calls.length = 0;
    client.pushAnswer = { kind: 'wait', ms: 7000 };
    loop.kick('save');
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls).toEqual(['push']);
    client.pushAnswer = { kind: 'idle' };
    await vi.advanceTimersByTimeAsync(7000);
    expect(client.calls).toEqual(['push', 'push', 'pull']);
    loop.stop();
  });
});
