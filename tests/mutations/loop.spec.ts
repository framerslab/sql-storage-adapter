import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncOutcome } from '../../src/features/sync/mutations/client';
import { changeChannel } from '../../src/features/sync/mutations/channel';
import { attachSyncLoop, SyncLoop, type KickReason } from '../../src/features/sync/mutations/loop';
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

  it('holds every kick while a rate refusal is waited, a kick during the refused cycle too, and a stop drops the wait', async () => {
    const client = fakeClient();
    const loop = new SyncLoop({ client, visible: () => true });
    client.pullAnswer = { kind: 'wait', ms: 5000 };
    loop.start();
    loop.kick('save');
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls).toEqual(['push', 'pull']);
    client.pullAnswer = { kind: 'applied' };
    loop.kick('save');
    loop.kick('visible');
    loop.kick('online');
    await vi.advanceTimersByTimeAsync(4000);
    expect(client.calls).toEqual(['push', 'pull']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.calls).toEqual(['push', 'pull', 'push', 'pull']);
    client.calls.length = 0;
    client.pushAnswer = { kind: 'wait', ms: 9000 };
    loop.kick('save');
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls).toEqual(['push']);
    loop.stop();
    client.pushAnswer = { kind: 'idle' };
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls).toEqual(['push', 'push', 'pull']);
    loop.stop();
  });

  it('keeps trying again when its error listener throws', async () => {
    const client = fakeClient();
    client.fail = true;
    const errors: unknown[] = [];
    const loop = new SyncLoop({
      client,
      visible: () => true,
      onError: (error) => {
        errors.push(error);
        throw new Error('the listener failed');
      },
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.calls).toEqual(['push', 'push']);
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(error).toBeInstanceOf(SyncUnavailable);
    loop.stop();
  });

  it('schedules nothing from a cycle a stop overtook: the loop started again runs its own cycle at once', async () => {
    let answer: (outcome: SyncOutcome) => void = () => undefined;
    const calls: string[] = [];
    const client = {
      push(): Promise<SyncOutcome> {
        calls.push('push');
        if (calls.length > 1) return Promise.resolve<SyncOutcome>({ kind: 'idle' });
        // the first push is answered when the test says, after the loop has stopped and started again
        return new Promise<SyncOutcome>((resolve) => {
          answer = resolve;
        });
      },
      async pull(): Promise<SyncOutcome> {
        calls.push('pull');
        return { kind: 'applied' };
      },
    };
    const loop = new SyncLoop({ client, visible: () => true });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['push']);
    loop.stop();
    loop.start();
    answer({ kind: 'wait', ms: 9000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['push', 'push', 'pull']);
    loop.stop();
  });

  it('starts its retries from 2 seconds again when it starts after a stop', async () => {
    const client = fakeClient();
    client.fail = true;
    const loop = new SyncLoop({ client, visible: () => true });
    loop.start();
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000);
    expect(client.calls).toEqual(['push', 'push', 'push', 'push']);
    loop.stop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.calls).toHaveLength(6);
    loop.stop();
  });
});

describe('attaching the loop to a page', () => {
  it('kicks on becoming visible, on focus while visible and on coming online, and never after the detach', () => {
    const loop = new SyncLoop({ client: fakeClient() });
    const kicks: KickReason[] = [];
    vi.spyOn(loop, 'kick').mockImplementation((reason) => {
      kicks.push(reason);
    });
    const page = { window: new EventTarget(), document: Object.assign(new EventTarget(), { visibilityState: 'hidden' }) };
    const detach = attachSyncLoop(loop, page as unknown as { window: Window; document: Document });
    const fire = (): void => {
      page.document.dispatchEvent(new Event('visibilitychange'));
      page.window.dispatchEvent(new Event('focus'));
      page.window.dispatchEvent(new Event('online'));
    };
    fire();
    expect(kicks).toEqual(['online']);
    page.document.visibilityState = 'visible';
    fire();
    expect(kicks).toEqual(['online', 'visible', 'visible', 'online']);
    detach();
    fire();
    expect(kicks).toEqual(['online', 'visible', 'visible', 'online']);
  });
});

describe('the change channel', () => {
  it('tells the other channels of its name, a detached listener hears nothing more, and with no BroadcastChannel it is silent', async () => {
    const sender = changeChannel('sync-loop-spec');
    const receiver = changeChannel('sync-loop-spec');
    try {
      let early = 0;
      const first = new Promise<void>((resolve) => {
        const detach = receiver.listen(() => {
          early += 1;
          detach();
          resolve();
        });
      });
      sender.post();
      await first;
      const second = new Promise<void>((resolve) => {
        receiver.listen(() => resolve());
      });
      sender.post();
      await second;
      expect(early).toBe(1);
    } finally {
      sender.close();
      receiver.close();
    }
    vi.stubGlobal('BroadcastChannel', undefined);
    try {
      const silent = changeChannel('sync-loop-spec');
      const heard: string[] = [];
      const detach = silent.listen(() => {
        heard.push('heard');
      });
      silent.post();
      detach();
      silent.close();
      expect(heard).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
