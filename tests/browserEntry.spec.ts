import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// A page that imports '@framers/sql-storage-adapter/browser' must not pull a
// Node built-in or a server driver into its bundle. The walk below starts at an
// entry, follows every relative import through src/ and collects the bare
// specifiers it meets, so a module added to the entry, or an import added to one
// of the modules it reaches, shows here before a page's bundle breaks.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/**
 * The modules a file loads at run time, read from its syntax tree: each import
 * and re-export that is not for types alone (`import type`, `export type`, or
 * every name marked `type`, which the compiler erases), each `import()` call and
 * each `require()` call, a computed specifier as `<computed>`.
 */
function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typesOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)));
      if (!typesOnly) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const typesOnly =
        node.isTypeOnly ||
        (node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((element) => element.isTypeOnly));
      if (!typesOnly) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [specifier] = node.arguments;
      specifiers.push(specifier !== undefined && ts.isStringLiteralLike(specifier) ? specifier.text : '<computed>');
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return specifiers;
}

/** The source file a relative specifier names: `./x.js` is read as `./x.ts`, and a folder as its index. */
function resolveSource(from: string, specifier: string): string {
  const base = path.resolve(path.dirname(from), specifier.replace(/\.js$/, ''));
  const found = [`${base}.ts`, path.join(base, 'index.ts')].find((candidate) => fs.existsSync(candidate));
  if (found === undefined) throw new Error(`cannot follow ${specifier} from ${from}`);
  return found;
}

/** Every bare specifier the entry reaches at run time, through each module its relative imports name. */
function bareImports(entry: string): Set<string> {
  const bare = new Set<string>();
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      if (specifier.startsWith('.')) pending.push(resolveSource(file, specifier));
      else bare.add(specifier);
    }
  }
  return bare;
}

/** A Node built-in, in either spelling, or a server driver. */
const NODE_ONLY = (name: string): boolean =>
  name.startsWith('node:') || builtinModules.includes(name) || ['pg', 'better-sqlite3'].includes(name.split('/')[0]);

describe('the browser entry', () => {
  it('imports no Node built-in and no pg, whatever it reaches', () => {
    const bare = [...bareImports(path.join(SRC, 'browser.ts'))];
    expect(bare.filter(NODE_ONLY)).toEqual([]);
    expect(bare.sort()).toEqual(['sql.js']);
  });

  it('sees a Node built-in where one is: the main entry reaches fs and path through the sql.js adapter, node:crypto through the blob codec and pg through an import() call in the Postgres adapter', () => {
    // The control case: a walk that followed nothing, or skipped import() calls, would pass the case above with less.
    const bare = [...bareImports(path.join(SRC, 'index.ts'))];
    expect(bare.filter(NODE_ONLY)).toEqual(expect.arrayContaining(['fs', 'path', 'node:crypto', 'pg']));
  });

  it('exports the IndexedDB adapter, the key-value module with the migration, the lock, the client and its parts', async () => {
    const entry = await import('../src/browser');
    for (const name of [
      'IndexedDbAdapter',
      'IndexedDbConflictError',
      'createSqlKeyValueStore',
      'namespaced',
      'MemoryKeyValueStore',
      'openIndexedDbStore',
      'migrateIndexedDbKeyValue',
      'MIGRATION_MARKER',
      'createTabLock',
      'MutationClient',
      'createFetchMutationTransport',
      'SyncLoop',
      'attachSyncLoop',
      'changeChannel',
      'planRowChanges',
      'readCounter',
    ]) {
      expect(entry).toHaveProperty(name);
    }
  });
});
