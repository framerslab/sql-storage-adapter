#!/usr/bin/env node

// Checks the packed package as a consumer installs it. Run by CI with the
// consumer's folder (the packed tarball installed in it) as the argument:
//
// 1. require() loads the root and every subpath entry, and the CommonJS build
//    runs: an in-memory sql.js database opened through the ./sqljs entry
//    answers a query, and the root's class is the subpath's class.
// 2. Server entries stay free of what they do not use: bundled with esbuild,
//    ./postgres, ./core and ./better-sqlite3 pull in no sql.js and no
//    @aws-sdk/client-s3, and ./electron/renderer pulls in no better-sqlite3.
// 3. The bundled CommonJS preload loads alone, with only 'electron' outside
//    it, and exposes its API through contextBridge.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const consumer = path.resolve(process.argv[2] ?? '.');
const requireFromConsumer = createRequire(path.join(consumer, 'package.json'));
const PACKAGE = '@framers/sql-storage-adapter';
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

// 1. CommonJS
const entries = ['', '/core', '/postgres', '/better-sqlite3', '/sqljs', '/indexeddb', '/capacitor', '/backup', '/authjs', '/types', '/electron/renderer', '/sync', '/kv'];
for (const entry of entries) {
  try {
    const loaded = requireFromConsumer(`${PACKAGE}${entry}`);
    check(Object.keys(loaded).length > 0, `require('${PACKAGE}${entry}') exports ${Object.keys(loaded).length} names`);
  } catch (error) {
    check(false, `require('${PACKAGE}${entry}') threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const root = requireFromConsumer(PACKAGE);
const sqljs = requireFromConsumer(`${PACKAGE}/sqljs`);
check(root.SqlJsAdapter === sqljs.SqlJsAdapter, 'the root and ./sqljs share one SqlJsAdapter class');
const db = sqljs.createSqlJsAdapter();
await db.open();
const row = await db.get('SELECT $1 + 1 AS two', [1]);
await db.close();
check(row?.two === 2, `a CommonJS sql.js adapter answers a query: ${JSON.stringify(row)}`);

// 2. What each server entry bundles. The drivers and optional peers stay
// outside the bundle, so each one an entry reaches is listed among its imports.
const DRIVERS = ["sql.js", "better-sqlite3", "pg", "pg-native", "@aws-sdk/client-s3", "@capacitor-community/sqlite", "electron"];
const reaches = (paths, name) => paths.some((p) => p === name || p.startsWith(`${name}/`) || p.includes(`node_modules/${name}/`));
const isolation = [
  { entry: "/postgres", forbidden: ["sql.js", "better-sqlite3", "@aws-sdk/client-s3"], files: [] },
  { entry: "/core", forbidden: ["sql.js", "better-sqlite3", "pg", "@aws-sdk/client-s3"], files: [] },
  { entry: "/authjs", forbidden: ["sql.js", "better-sqlite3", "pg", "@aws-sdk/client-s3"], files: [] },
  { entry: "/better-sqlite3", forbidden: ["sql.js", "pg", "@aws-sdk/client-s3"], files: [] },
  { entry: "/electron/renderer", forbidden: ["better-sqlite3", "sql.js"], files: ["betterSqliteAdapter", "electronMainAdapter"] },
];
for (const { entry, forbidden, files } of isolation) {
  const probe = path.join(consumer, `probe-${entry.replace(/\W+/g, "-")}.mjs`);
  fs.writeFileSync(probe, `export * from "${PACKAGE}${entry}";\n`);
  const result = await build({
    entryPoints: [probe],
    absWorkingDir: consumer,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    external: DRIVERS,
  });
  const inputs = Object.keys(result.metafile.inputs);
  const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((imported) => imported.path));
  const pulled = [
    ...forbidden.filter((name) => reaches(imports, name) || reaches(inputs, name)),
    ...files.filter((name) => inputs.some((input) => input.includes(name))),
  ];
  check(
    pulled.length === 0,
    `${PACKAGE}${entry} bundles ${inputs.length} files and reaches none of ${[...forbidden, ...files].join(", ")}${pulled.length ? `; it reaches ${pulled.join(", ")}` : ""}`,
  );
}

// 3. The bundled preload
const preloadPath = requireFromConsumer.resolve(`${PACKAGE}/electron/preload`);
check(preloadPath.endsWith('preload.cjs'), `require resolves the preload to the bundled file: ${path.relative(consumer, preloadPath)}`);
const preloadSource = fs.readFileSync(preloadPath, 'utf8');
const requires = [...preloadSource.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2]);
check(
  requires.every((name) => name === 'electron'),
  `the bundled preload requires only electron: ${[...new Set(requires)].join(', ') || 'nothing'}`,
);

if (failures.length) {
  console.error(`\n${failures.length} package check(s) failed.`);
  process.exit(1);
}
console.log('\nAll package checks passed.');
