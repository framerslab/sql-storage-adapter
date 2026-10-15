// Run by tests/postgres.connection.spec.ts in a child process through vite-node.
// It opens a Postgres adapter, runs one query and never closes it. With
// ALLOW_EXIT_ON_IDLE=1 the process ends once the pool is idle; without it the
// idle connection keeps the process running (idleTimeoutMillis 0 turns off the
// pool's idle timer, which would otherwise end the connection after 10 s).
import { createPostgresAdapter } from '../../src/index.js';

const main = async (): Promise<void> => {
  const adapter = createPostgresAdapter({
    connectionString: process.env.POSTGRES_TEST_URL as string,
    max: 1,
    idleTimeoutMillis: 0,
    allowExitOnIdle: process.env.ALLOW_EXIT_ON_IDLE === '1',
  });
  await adapter.open();
  await adapter.get('SELECT 1 AS one');
  process.stdout.write('queried\n');
};

await main();
