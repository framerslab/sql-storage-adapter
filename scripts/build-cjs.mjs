#!/usr/bin/env node

// The CommonJS half of the package, built from the ES module output of tsc.
//
// 1. Every dist/**/*.js file is transformed to CommonJS into the same path
//    under dist/cjs/, so require('@framers/sql-storage-adapter') and each
//    subpath load one module per file, as the ES module build does: a class
//    has one identity whichever entry a caller takes it from.
// 2. dist/cjs/package.json says "type": "commonjs", so Node and TypeScript
//    read the .js files and the declarations under it as CommonJS. It repeats
//    the root's "browser" field: webpack reads that field from the
//    package.json nearest the importing file, which for these files is this
//    one.
// 3. The declarations are copied beside them, so a CommonJS TypeScript
//    consumer under --moduleResolution node16 resolves types without
//    importing an ES module.
// 4. The Electron preload is bundled into one CommonJS file
//    (dist/adapters/electron/preload.cjs) with only 'electron' left outside,
//    as a sandboxed preload must be.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const cjsDir = path.join(distDir, 'cjs');

/** Every file under `dir` whose name ends with one of `suffixes`, leaving dist/cjs out. */
function collect(dir, suffixes) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== cjsDir) files.push(...collect(full, suffixes));
    } else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      files.push(full);
    }
  }
  return files;
}

fs.rmSync(cjsDir, { recursive: true, force: true });

// import.meta.url has no CommonJS form: each file that reads it gets its own
// file URL from __filename.
const IMPORT_META_BANNER = "const __importMetaUrl = require('url').pathToFileURL(__filename).href;";

for (const file of collect(distDir, ['.js'])) {
  const source = fs.readFileSync(file, 'utf8');
  const readsImportMeta = source.includes('import.meta');
  const result = await transform(source, {
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcefile: path.relative(root, file),
    // require() for import(): a CommonJS consumer's bundler resolves optional
    // drivers (pg, sql.js, better-sqlite3) as requires, and Node loads them so.
    supported: { 'dynamic-import': false },
    ...(readsImportMeta ? { define: { 'import.meta.url': '__importMetaUrl' }, banner: IMPORT_META_BANNER } : {}),
  });
  const target = path.join(cjsDir, path.relative(distDir, file));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, result.code);
}

for (const file of collect(distDir, ['.d.ts'])) {
  const target = path.join(cjsDir, path.relative(distDir, file));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
}

const { browser } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const cjsPackage = browser === undefined ? { type: 'commonjs' } : { type: 'commonjs', browser };
fs.writeFileSync(path.join(cjsDir, 'package.json'), `${JSON.stringify(cjsPackage, null, 2)}\n`);

await build({
  entryPoints: [path.join(root, 'src/adapters/electron/preload.ts')],
  outfile: path.join(distDir, 'adapters/electron/preload.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['electron'],
  logLevel: 'warning',
});

console.log(`CommonJS build written to ${path.relative(root, cjsDir)}, and the bundled preload to dist/adapters/electron/preload.cjs`);
