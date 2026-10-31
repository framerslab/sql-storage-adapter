/**
 * @fileoverview The pg this library loads, as the PostgreSQL exporter reads it to call a pool's password function
 * as pg does: its version, which decides the function's arguments, and its `Client`, on which pg calls it.
 * @module sql-storage-adapter/exporters/pgModule
 */

/** pg's `Client`, as far as the exporter uses one: it is made of a pool's settings and never connected. */
export type PgClientClass = new (config: object) => { connectionParameters?: unknown };

/** The pg this library loads. A part that cannot be read is undefined. */
export interface LoadedPg {
  /** The version in pg's `package.json`. */
  version?: string;
  Client?: PgClientClass;
}

let loading: Promise<LoadedPg> | undefined;

/**
 * Reads the pg that a `require` from this module resolves, which is the pg the Postgres adapter's `import('pg')`
 * loads. Its `package.json` is found from the file `pg` resolves to, up through the directories above it, and not
 * as `pg/package.json`, which the exports map of pg 8.15.0 to 8.16.0 does not export. Read once.
 */
export const loadPg = (): Promise<LoadedPg> => {
  loading ??= readPg();
  return loading;
};

const readPg = async (): Promise<LoadedPg> => {
  const loaded: LoadedPg = {};
  try {
    const [{ createRequire }, fs, path] = await Promise.all([
      import('node:module'),
      import('node:fs'),
      import('node:path'),
    ]);
    const require = createRequire(import.meta.url);
    for (let dir = path.dirname(require.resolve('pg')); ; dir = path.dirname(dir)) {
      const file = path.join(dir, 'package.json');
      if (fs.existsSync(file)) {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown };
        if (pkg.name === 'pg') {
          if (typeof pkg.version === 'string') loaded.version = pkg.version;
          break;
        }
      }
      if (path.dirname(dir) === dir) break;
    }
    const pg = require('pg') as { Client?: unknown };
    if (typeof pg.Client === 'function') loaded.Client = pg.Client as PgClientClass;
  } catch {
    // What was read stays; the exporter says what it does without the rest.
  }
  return loaded;
};
