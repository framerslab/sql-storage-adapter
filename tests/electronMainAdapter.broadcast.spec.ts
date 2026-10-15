import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElectronMainAdapter } from '../src/adapters/electron/electronMainAdapter';

// The Electron main adapter tells every window what a run() changed. It found
// the statement's tables with matchAll(), which throws for a pattern without
// the global flag, so every run() threw after its write had been made.

const { sent } = vi.hoisted(() => ({ sent: [] as Array<{ channel: string; change: { type: string; tables: string[] } }> }));

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, change: { type: string; tables: string[] }) => sent.push({ channel, change }),
        },
      },
    ],
  },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
}));
vi.mock('../src/adapters/electron/ipc/protocol', () => ({
  initializeIpcProtocol: () => undefined,
  disposeIpcProtocol: () => undefined,
}));

describe('ElectronMainAdapter run()', () => {
  const dirs: string[] = [];

  afterEach(() => {
    sent.length = 0;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves with the changes of each write and tells the windows which table it changed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-main-'));
    dirs.push(dir);
    const adapter = createElectronMainAdapter({
      filePath: path.join(dir, 'app.db'),
      wal: { enabled: false },
      recovery: { enabled: false },
    });
    await adapter.open();
    try {
      await adapter.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
      // exec() tells the windows of a change too, naming no table.
      sent.length = 0;

      expect(await adapter.run('INSERT INTO items (label) VALUES (?)', ['one'])).toMatchObject({ changes: 1 });
      expect(await adapter.run('UPDATE items SET label = ? WHERE id = ?', ['two', 1])).toMatchObject({ changes: 1 });
      expect(await adapter.run('DELETE FROM items WHERE id = ?', [1])).toMatchObject({ changes: 1 });

      expect(sent.map(({ change }) => [change.type, change.tables])).toEqual([
        ['insert', ['items']],
        ['update', ['items']],
        ['delete', ['items']],
      ]);
    } finally {
      await adapter.close();
    }
  });
});
