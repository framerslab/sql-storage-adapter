import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElectronMainAdapter, type CloudBackupProvider } from '../src/adapters/electron/electronMainAdapter';

// The cloud backup wrote `VACUUM INTO '<file>.backup'` with the file's path unescaped, so a path holding an apostrophe
// (a home folder named O'Brien) ended the SQL string early and every backup failed.

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
}));

vi.mock('../src/adapters/electron/ipc/protocol', () => ({
  initializeIpcProtocol: () => undefined,
  disposeIpcProtocol: () => undefined,
}));

describe('ElectronMainAdapter runBackup()', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("backs up a database whose path holds an apostrophe and uploads the copy", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "electron-backup-O'Brien-"));
    dirs.push(dir);
    const uploaded: Array<{ local: string; remote: string }> = [];
    const provider: CloudBackupProvider = {
      upload: async (local, remote) => {
        uploaded.push({ local, remote });
      },
      download: async () => undefined,
      list: async () => [],
      delete: async () => undefined,
    };
    const filePath = path.join(dir, 'app.db');
    const adapter = createElectronMainAdapter({ filePath, wal: { enabled: false }, recovery: { enabled: false }, backup: { provider } });
    await adapter.open();
    try {
      await adapter.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL); INSERT INTO notes (body) VALUES ('kept')");
      await adapter.runBackup();
      expect(uploaded).toHaveLength(1);
      expect(uploaded[0]!.local).toBe(`${filePath}.backup`);
      expect(fs.statSync(`${filePath}.backup`).size).toBeGreaterThan(0);
    } finally {
      await adapter.close();
    }
  });
});
