// Run by tests/betterSqliteAdapter.writeLock.spec.ts in a child process through
// vite-node: a second process writing the same SQLite file through the
// better-sqlite3 adapter. It opens SQLITE_WRITER_FILE and prints "ready". On a
// "go" line it runs one transaction that reads the counter, prints "read <n>",
// waits for a "committed" line, and writes n + 1. With SQLITE_WRITER_COMMIT_AFTER_MS
// set it waits that many milliseconds in place of the "committed" line, so it
// holds the write lock for that long by itself. With SQLITE_WRITER_READ_ONLY=1
// it begins the transaction with { readOnly: true } and writes nothing: it
// holds a read for that long. It prints "done" and ends 0 when the transaction
// committed, and prints "failed <code> <message>" and ends 1 when it did not.
import { createInterface } from 'node:readline';
import { createBetterSqliteAdapter } from '../../src/index.js';

const queued: string[] = [];
const waiting: Array<(line: string) => void> = [];
createInterface({ input: process.stdin }).on('line', (line) => {
  const next = waiting.shift();
  if (next) {
    next(line.trim());
  } else {
    queued.push(line.trim());
  }
});

const nextLine = (): Promise<string> =>
  new Promise((resolve) => {
    const line = queued.shift();
    if (line !== undefined) {
      resolve(line);
    } else {
      waiting.push(resolve);
    }
  });

const until = async (expected: string): Promise<void> => {
  while ((await nextLine()) !== expected) {
    // Skip anything else.
  }
};

const commitAfterMs = Number(process.env.SQLITE_WRITER_COMMIT_AFTER_MS);
const readOnly = process.env.SQLITE_WRITER_READ_ONLY === '1';

const main = async (): Promise<void> => {
  const adapter = createBetterSqliteAdapter(process.env.SQLITE_WRITER_FILE as string);
  await adapter.open();
  process.stdout.write('ready\n');
  await until('go');
  try {
    await adapter.transaction(async (trx) => {
      const row = await trx.get<{ n: number }>('SELECT n FROM counter WHERE id = 1');
      process.stdout.write(`read ${row?.n}\n`);
      if (commitAfterMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, commitAfterMs));
      } else {
        await until('committed');
      }
      if (!readOnly) await trx.run('UPDATE counter SET n = ? WHERE id = 1', [Number(row?.n) + 1]);
    }, { readOnly });
    process.stdout.write('done\n');
    await adapter.close();
    process.exit(0);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    process.stdout.write(`failed ${String(code)} ${error instanceof Error ? error.message : String(error)}\n`);
    await adapter.close();
    process.exit(1);
  }
};

await main();
