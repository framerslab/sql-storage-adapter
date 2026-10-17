import { describe, expect, it } from 'vitest';
import { createTabLock, leaseTabLock } from '../../src/features/sync/mutations/tabLock';

// The tab lock on the browsers' own Web Locks and IndexedDB, run by Playwright
// in Chromium, WebKit and Firefox.

async function order(lockA: { run<T>(w: () => Promise<T>): Promise<T> }, lockB: { run<T>(w: () => Promise<T>): Promise<T> }): Promise<string[]> {
  const steps: string[] = [];
  const work = (name: string) => async () => {
    steps.push(`${name} in`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    steps.push(`${name} out`);
  };
  await Promise.all([lockA.run(work('a')), lockB.run(work('b'))]);
  return steps;
}

describe("the tab lock in the engine's own APIs", () => {
  it('holds one Web Lock at a time', async () => {
    const name = `lock-${crypto.randomUUID()}`;
    const one = createTabLock(name);
    expect(one.mode).toBe('web-locks');
    expect(await order(one, createTabLock(name))).toEqual(['a in', 'a out', 'b in', 'b out']);
  });

  it("holds one lease at a time in the engine's IndexedDB", async () => {
    const name = `lease-${crypto.randomUUID()}`;
    expect(await order(leaseTabLock({ name }), leaseTabLock({ name }))).toEqual(['a in', 'a out', 'b in', 'b out']);
  });
});
