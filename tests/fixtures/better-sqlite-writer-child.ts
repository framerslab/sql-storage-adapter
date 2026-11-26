// Run by tests/betterSqliteAdapter.writeLock.spec.ts in a child process through
// vite-node: a second process writing the same SQLite file through the
// better-sqlite3 adapter. It opens SQLITE_WRITER_FILE and prints "ready". On a
// "go" line it runs one transaction that reads the counter, prints "read <n>",
// waits for a "committed" line, and writes n + 1. It prints "done" and ends 0
// when the transaction committed, and prints "failed <code> <message>" and
// ends 1 when it did not.
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

const main = async (): Promise<void> => {
  const adapter = createBetterSqliteAdapter(process.env.SQLITE_WRITER_FILE as string);
  await adapter.open();
  process.stdout.write('ready\n');
  await until('go');
  try {
    await adapter.transaction(async (trx) => {
      const row = await trx.get<{ n: number }>('SELECT n FROM counter WHERE id = 1');
      process.stdout.write(`read ${row?.n}\n`);
      await until('committed');
      await trx.run('UPDATE counter SET n = ? WHERE id = 1', [Number(row?.n) + 1]);
    });
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
