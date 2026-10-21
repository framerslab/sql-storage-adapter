import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutoMigrator } from '../src/adapters/electron/migration/autoMigrator';
import { SqlJsAdapter } from '../src/adapters/sqlJsAdapter';

// The auto-migrator records the app's version beside each migration it runs. With no getAppVersion of the caller's it
// asks Electron's app first, then the package.json of the working directory. Its ES module build has no require of its
// own, so it never asked Electron and recorded package.json's version, or 0.0.0, in an Electron app too.

const { electron } = vi.hoisted(() => ({ electron: { module: undefined as unknown } }));

// A require made by createRequire answers 'electron' with the module a case sets; with none set, it answers as Node
// does, which outside Electron is the path of the Electron binary, with no app on it.
vi.mock('module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('module')>();
  return {
    ...actual,
    createRequire: (from: string | URL) => {
      const real = actual.createRequire(from);
      const answer = (id: string): unknown => (id === 'electron' && electron.module !== undefined ? electron.module : real(id));
      return Object.assign(answer, { resolve: real.resolve, cache: real.cache, extensions: real.extensions, main: real.main });
    },
  };
});

describe('the auto-migrator with no getAppVersion of its caller', () => {
  const dirs: string[] = [];

  afterEach(() => {
    electron.module = undefined;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs one migration from a directory of its own and answers the app version recorded beside it. */
  async function recordedAppVersion(): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-migrator-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, '001_create_items.sql'), 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);\n');
    const adapter = new SqlJsAdapter();
    await adapter.open();
    try {
      const migrator = createAutoMigrator(adapter, { migrationsPath: dir });
      await migrator.initialize();
      const applied = await migrator.getAppliedMigrations();
      expect(applied.map((migration) => migration.name)).toEqual(['create_items']);
      return applied[0].appVersion;
    } finally {
      await adapter.close();
    }
  }

  it("records the version Electron's app reports", async () => {
    electron.module = { app: { getVersion: () => '4.5.6' } };
    expect(await recordedAppVersion()).toBe('4.5.6');
  });

  it("records the working directory's package.json version where Electron has no app", async () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
    expect(await recordedAppVersion()).toBe(version);
  });
});
