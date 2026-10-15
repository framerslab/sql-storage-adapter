#!/usr/bin/env node

// Gives every relative import specifier under dist/ the file it names.
//
// tsc copies specifiers as the source writes them ('./types',
// './core/database'). Node's ES module loader, and TypeScript reading this
// "type": "module" package under --moduleResolution node16 or nodenext,
// resolve a relative specifier only when it names its file: neither adds an
// extension nor looks up a folder's index. So a specifier that names a module
// file gets '.js' and one that names a folder with an index gets '/index.js',
// in the JavaScript and in the declarations alike.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '..', 'dist');

/** Emitted files whose specifiers are rewritten: ES module JavaScript and declarations. */
const REWRITTEN_SUFFIXES = ['.js', '.mjs', '.d.ts', '.d.mts'];

/** The files tsc emits for a module that a '.js' specifier names. */
const MODULE_SUFFIXES = ['.js', '.d.ts'];

/** Each pattern captures the text before a relative specifier, the specifier and the text after it. */
const SPECIFIER_PATTERNS = [
  // import ... from './x' and export ... from './x', type-only forms included
  /(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
  // import('./x') in JavaScript, import("./x").Name in declarations
  /(import\(\s*['"])(\.{1,2}\/[^'"]+)(['"]\s*[,)])/g,
  // import './x' for its side effects
  /(\bimport\s+['"])(\.{1,2}\/[^'"]+)(['"])/g
];

function collectFiles(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile() && REWRITTEN_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      files.push(fullPath);
    }
  }
  return files;
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** True when tsc emitted the module at `modulePath`: its JavaScript or its declarations. */
function isEmittedModule(modulePath) {
  return MODULE_SUFFIXES.some((suffix) => isFile(`${modulePath}${suffix}`));
}

/**
 * Returns `specifier` with '.js' when it names a module file, with '/index.js'
 * when it names a folder with an index, and unchanged otherwise: not relative,
 * already carrying an extension, or naming nothing under dist/.
 */
function resolveSpecifier(filePath, specifier) {
  if (!specifier.startsWith('.')) {
    return specifier;
  }

  const hasKnownExtension = /\.(?:[cm]?js|json|node)$/i.test(specifier);
  if (hasKnownExtension) {
    return specifier;
  }

  const modulePath = path.join(path.dirname(filePath), specifier);
  if (isEmittedModule(modulePath)) {
    return `${specifier}.js`;
  }

  if (isEmittedModule(path.join(modulePath, 'index'))) {
    return `${specifier}/index.js`;
  }

  return specifier;
}

/** Rewrites the relative specifiers in one file and returns how many it changed. */
function rewriteSpecifiers(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  let modified = original;
  let rewritten = 0;

  for (const pattern of SPECIFIER_PATTERNS) {
    modified = modified.replace(pattern, (match, prefix, specifier, suffix) => {
      const resolved = resolveSpecifier(filePath, specifier);
      if (resolved === specifier) {
        return match;
      }
      rewritten += 1;
      return `${prefix}${resolved}${suffix}`;
    });
  }

  if (rewritten > 0) {
    fs.writeFileSync(filePath, modified, 'utf8');
  }
  return rewritten;
}

if (!fs.existsSync(distDir)) {
  console.log('[fix-esm-imports] dist directory missing; nothing to do.');
  process.exit(0);
}

const files = collectFiles(distDir);
let rewrittenCount = 0;
for (const file of files) {
  rewrittenCount += rewriteSpecifiers(file);
}

const declarationCount = files.filter((file) => /\.d\.m?ts$/.test(file)).length;
console.log(
  `[fix-esm-imports] Rewrote ${rewrittenCount} specifiers in ${files.length} files ` +
    `(${files.length - declarationCount} JavaScript, ${declarationCount} declarations) under ${distDir}.`
);
