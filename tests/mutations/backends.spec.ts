import { describe, expect, it } from 'vitest';
import { backends } from './backends';

const BACKENDS = await backends();

describe("the sync suites' databases", () => {
  it('has sql.js always, and Postgres whenever the run requires it', () => {
    const names = BACKENDS.map((backend) => backend.name);
    expect(names).toContain('sqljs');
    if (process.env.SYNC_TEST_REQUIRE_POSTGRES === '1') expect(names).toContain('postgres');
  });

  it.each(BACKENDS.map((backend) => [backend.name, backend] as const))('%s commits a statement made in a transaction', async (_name, backend) => {
    const opened = await backend.open();
    try {
      await opened.adapter.exec(`CREATE TABLE ${opened.prefix}probe (id TEXT PRIMARY KEY)`);
      await opened.adapter.transaction(async (trx) => {
        await trx.run(`INSERT INTO ${opened.prefix}probe (id) VALUES (?)`, ['a']);
      });
      expect(await opened.adapter.all(`SELECT id FROM ${opened.prefix}probe`)).toEqual([{ id: 'a' }]);
    } finally {
      await opened.close();
    }
  });
});
