import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '../../src/core/contracts';
import { RemovalInProgress, RemovalInvalidated } from '../../src/features/sync/mutations/client';
import { createSqlGroup, dropSqlGroup } from '../../src/features/sync/mutations/sqlStore';
import { backends } from './backends';
import { browser, dump, hex, restore, settle, world, type World } from './harness';

const BACKENDS = await backends();

describe.each(BACKENDS.map((backend) => [backend.name, backend] as const))('removal and repair on %s', (_name, backend) => {
  let w: World;

  beforeEach(async () => {
    w = await world(backend);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await w.close();
  });

  it("keeps a downloaded row the restore lost though its browser never edited it, across a reload, a failed apply and another restore, until a save puts it back", async () => {
    const a = await browser(w);
    const b = await browser(w);
    await a.join();
    await b.join();
    const empty = await dump(w);
    await a.save([{ id: hex(1), value: 'only in the account' }]);
    await settle(a, b);
    expect(await b.values()).toEqual(['only in the account']);
    await a.client.beginRemoval();
    await a.client.removeAll(async (trx) => {
      await trx.run('DELETE FROM test_blocks');
    }, (await a.client.backedUp(await a.blocks())).stamp);
    await restore(w, empty);
    await settle(b);
    expect(await b.values()).toEqual(['only in the account']);
    expect((await b.client.snapshot()).kept).toMatchObject([{ id: hex(1), reason: 'recovery' }]);
    const reloaded = b.reopen();
    expect((await reloaded.client.snapshot()).kept).toMatchObject([{ id: hex(1), reason: 'recovery' }]);
    await restore(w, empty);
    // the tab closes in the middle of handling the second restore: the pull's first transaction reads its context, the
    // second keeps the downloaded rows aside, and that one fails
    const original = reloaded.adapter.transaction.bind(reloaded.adapter) as StorageAdapter['transaction'];
    let transactions = 0;
    vi.spyOn(reloaded.adapter, 'transaction').mockImplementation((async (fn: Parameters<StorageAdapter['transaction']>[0]) => {
      transactions += 1;
      if (transactions === 2) throw new Error('the tab was closed mid-apply');
      return original(fn);
    }) as StorageAdapter['transaction']);
    await expect(reloaded.client.pull()).rejects.toThrow('the tab was closed mid-apply');
    vi.restoreAllMocks();
    await settle(reloaded);
    expect(await reloaded.values()).toEqual(['only in the account']);
    expect(await reloaded.client.restoreKept(hex(1))).toBe(true);
    await settle(reloaded);
    expect((await reloaded.client.snapshot()).kept).toEqual([]);
    expect(await w.opened.adapter.all(`SELECT id FROM ${w.opened.prefix}rows WHERE id = ?`, [hex(1)])).toHaveLength(1);
  });

  it('backs a block only by a readable account copy of the same id and the same text, with nothing pending', async () => {
    const a = await browser(w);
    await a.join();
    await a.save([{ id: hex(1), value: 'one' }, { id: hex(2), value: 'two' }]);
    await settle(a);
    expect(await a.client.backedUp(await a.blocks())).toMatchObject({ checked: true, reason: null, unbacked: [] });
    const withLocal = [...(await a.blocks()), { id: null, value: 'a value no account holds' }];
    expect((await a.client.backedUp(withLocal)).unbacked).toEqual([{ id: null, value: 'a value no account holds' }]);
    expect((await a.client.backedUp([{ id: hex(1), value: 'one, changed here' }])).unbacked).toEqual([{ id: hex(1), value: 'one, changed here' }]);
    a.transport.offline = true;
    await a.save([...(await a.blocks()), { id: hex(3), value: 'three' }]);
    expect(await a.client.backedUp(await a.blocks())).toMatchObject({ checked: false, reason: 'pending' });
    a.transport.offline = false;
    await settle(a);
    // the account's copy of row 2 becomes unreadable at a new version, as a lost key or a moved value would leave it
    await w.opened.adapter.run(`UPDATE ${w.opened.prefix}rows SET stored = ?, version = 99 WHERE id = ?`, ['garbage', hex(2)]);
    await w.opened.adapter.run(`UPDATE ${w.opened.prefix}groups SET version = 99 WHERE scope = ?`, [w.scope]);
    await settle(a);
    const check = await a.client.backedUp(await a.blocks());
    expect(check.checked).toBe(true);
    expect(check.unbacked).toEqual([{ id: hex(2), value: 'two' }]);
    w.epoch.current = hex(0xe77);
    expect(await a.client.pull()).toEqual({ kind: 'recovering' });
    expect(await a.client.backedUp(await a.blocks())).toMatchObject({ checked: false, reason: 'recovering' });
  });

  it('holds every save while a removal runs, voids a confirmation another tab changed, and leaves a declined choice', async () => {
    const a = await browser(w);
    await a.join();
    await a.save([{ id: hex(1), value: 'one' }]);
    await settle(a);
    const first = await a.client.backedUp(await a.blocks());
    await a.client.beginRemoval();
    const tab = a.reopen();
    await expect(tab.save([...(await tab.blocks()), { id: hex(2), value: 'two' }])).rejects.toBeInstanceOf(RemovalInProgress);
    await a.client.cancelRemoval();
    await tab.save([...(await tab.blocks()), { id: hex(2), value: 'two' }]);
    await a.client.beginRemoval();
    await expect(a.client.removeAll(async () => undefined, first.stamp)).rejects.toBeInstanceOf(RemovalInvalidated);
    await settle(a);
    const second = await a.client.backedUp(await a.blocks());
    expect(second).toMatchObject({ checked: true, unbacked: [] });
    await a.client.removeAll(async (trx: StorageAdapter) => {
      await trx.run('DELETE FROM test_blocks');
    }, second.stamp);
    const after = await a.client.snapshot();
    expect(after.membership).toMatchObject({ state: 'declined', declinedGroup: w.group, removing: false });
    expect(after.membership.activation).not.toBe(first.stamp.split('|')[1]);
    expect(after.visible).toEqual([]);
    expect(await a.blocks()).toEqual([]);
    for (const table of ['rows', 'base', 'pending', 'journal', 'results', 'kept']) expect(await a.adapter.all(`SELECT * FROM sync_${table}`)).toEqual([]);
    expect((await w.opened.adapter.all(`SELECT id FROM ${w.opened.prefix}rows WHERE state = 'live'`)).length).toBe(2);
  });

  it('repairs an unreadable row at its revision with the healthy text, and releases the mark once the account reads it', async () => {
    const a = await browser(w);
    await a.join();
    await a.save([{ id: hex(1), value: 'healthy' }]);
    await settle(a);
    await w.opened.adapter.run(`UPDATE ${w.opened.prefix}rows SET stored = ?, version = 99 WHERE id = ?`, ['garbage', hex(1)]);
    await w.opened.adapter.run(`UPDATE ${w.opened.prefix}groups SET version = 99 WHERE scope = ?`, [w.scope]);
    await settle(a);
    expect((await a.client.snapshot()).kept).toMatchObject([{ id: hex(1), value: 'healthy', reason: 'unreadable' }]);
    expect(await a.values()).toEqual(['healthy']);
    expect(await a.client.repairUnreadable()).toBe(1);
    await settle(a);
    expect((await a.client.snapshot()).kept).toEqual([]);
    const fresh = await browser(w);
    await fresh.join();
    expect(await fresh.values()).toEqual(['healthy']);
  });

  it('removes a browser that never joined at once, with no removal step', async () => {
    const b = await browser(w);
    await b.save([{ id: null, value: 'local only' }]);
    await b.client.removeAll(async (trx: StorageAdapter) => {
      await trx.run('DELETE FROM test_blocks');
    });
    expect(await b.blocks()).toEqual([]);
    expect((await b.client.snapshot()).membership.state).toBe('off');
  });

  it('voids a confirmation once the account turns off under the open question, and removes nothing on a check that could not run', async () => {
    const a = await browser(w);
    await a.join();
    await a.save([{ id: hex(1), value: 'one' }]);
    await settle(a);
    await a.client.beginRemoval();
    const confirmed = await a.client.backedUp(await a.blocks());
    expect(confirmed).toMatchObject({ checked: true, unbacked: [] });
    // another device turns the account off while the question is open: this tab's pull learns group_gone and leaves
    await dropSqlGroup(w.opened.adapter, w.opened.prefix, w.scope);
    expect(await a.client.pull()).toEqual({ kind: 'off' });
    const remove = (trx: StorageAdapter): Promise<void> => trx.run('DELETE FROM test_blocks').then(() => undefined);
    await expect(a.client.removeAll(remove, confirmed.stamp)).rejects.toMatchObject({ name: 'RemovalInvalidated', reason: 'changed' });
    expect(await a.values()).toEqual(['one']);
    // a check that could not run (a mutation pending) confirms nothing, though nothing changed since it answered
    w.group = hex(0x6411);
    await createSqlGroup(w.opened.adapter, w.opened.prefix, w.scope, w.group);
    await a.join();
    await settle(a);
    a.transport.offline = true;
    await a.save([{ id: hex(1), value: 'one' }, { id: hex(2), value: 'two' }]);
    await a.client.beginRemoval();
    const unchecked = await a.client.backedUp(await a.blocks());
    expect(unchecked).toMatchObject({ checked: false, reason: 'pending' });
    await expect(a.client.removeAll(remove, unchecked.stamp)).rejects.toMatchObject({ name: 'RemovalInvalidated', reason: 'pending' });
    await expect(a.client.removeAll(remove)).rejects.toMatchObject({ name: 'RemovalInvalidated', reason: 'unchecked' });
    expect(await a.values()).toEqual(['one', 'two']);
    a.transport.offline = false;
  });

  it('never puts a removed row back under its tombstoned id: the put-back answers false, and the explicit save of a new row carries the value', async () => {
    const a = await browser(w);
    await a.join();
    await a.save([{ id: hex(1), value: 'one' }]);
    await settle(a);
    const b = await browser(w);
    await b.join();
    await settle(b);
    // a edits the row offline while b deletes it; a's edit comes back refused as removed and is kept in a's browser
    a.transport.offline = true;
    await a.save([{ id: hex(1), value: 'one, edited here' }]);
    await b.save([]);
    await settle(b);
    a.transport.offline = false;
    await settle(a);
    expect((await a.client.snapshot()).kept).toMatchObject([{ id: hex(1), value: 'one, edited here', reason: 'removed' }]);
    expect(await a.values()).toEqual(['one, edited here']);
    expect(await a.client.restoreKept(hex(1))).toBe(false);
    expect((await a.client.snapshot()).pending).toBe(0);
    // the separate explicit save as a new row: the value under a new id, the old block gone, the tombstone kept
    await a.save([{ id: hex(2), value: 'one, edited here' }]);
    await settle(a, b);
    expect((await a.client.snapshot()).kept).toEqual([]);
    expect(await a.values()).toEqual(['one, edited here']);
    expect(await b.values()).toEqual(['one, edited here']);
    expect(await w.opened.adapter.all(`SELECT id FROM ${w.opened.prefix}rows WHERE state = 'tombstone'`)).toEqual([{ id: hex(1) }]);
  });

  it("reads the client's own records alone: a save that issues no mutation leaves the stamp as it was, so a removal begins before its check, and from then such a save waits", async () => {
    const a = await browser(w);
    await a.join();
    await a.save([{ id: hex(1), value: 'one' }, { id: null, value: 'unsent' }]);
    await settle(a);
    const early = await a.client.backedUp(await a.blocks());
    const tab = a.reopen();
    // a block with no id changes in another tab: the save writes the caller's data and issues no mutation
    await tab.save([{ id: hex(1), value: 'one' }, { id: null, value: 'unsent, edited in another tab' }]);
    expect((await a.client.backedUp(await a.blocks())).stamp).toBe(early.stamp);
    await a.client.beginRemoval();
    const check = await a.client.backedUp(await a.blocks());
    expect(check.unbacked).toEqual([{ id: null, value: 'unsent, edited in another tab' }]);
    await expect(tab.save([{ id: hex(1), value: 'one' }, { id: null, value: 'edited again' }])).rejects.toBeInstanceOf(RemovalInProgress);
    await a.client.removeAll(async (trx: StorageAdapter) => {
      await trx.run('DELETE FROM test_blocks');
    }, check.stamp);
    expect(await a.blocks()).toEqual([]);
  });
});
