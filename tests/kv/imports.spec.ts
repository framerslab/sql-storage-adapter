import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// A page that loads '@framers/sql-storage-adapter/kv' for its key-value store
// must not load sql.js or pg with it. The module's files import one another and
// nothing else, but for types, which the build erases.

const KV_DIR = fileURLToPath(new URL('../../src/features/kv/', import.meta.url));

/** Each module the file reaches at run time, and each it names for types only. */
const importsOf = (file: string): { runtime: string[]; typesOnly: string[] } => {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const runtime: string[] = [];
  const typesOnly: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const onlyTypes =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)));
      (onlyTypes ? typesOnly : runtime).push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const onlyTypes =
        node.isTypeOnly ||
        (node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.every((element) => element.isTypeOnly));
      (onlyTypes ? typesOnly : runtime).push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const [specifier] = node.arguments;
      runtime.push(ts.isStringLiteral(specifier) ? specifier.text : '<computed>');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { runtime, typesOnly };
};

describe('the key-value module', () => {
  const files = fs
    .readdirSync(KV_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(KV_DIR, name));

  it('has its files where the package entry expects them', () => {
    expect(files.map((file) => path.basename(file)).sort()).toEqual(
      ['idb.ts', 'index.ts', 'indexedDbKeyValueStore.ts', 'keyValueStore.ts', 'sqlKeyValueStore.ts', 'valueCodec.ts'].sort(),
    );
  });

  it.each(['idb.ts', 'index.ts', 'indexedDbKeyValueStore.ts', 'keyValueStore.ts', 'sqlKeyValueStore.ts', 'valueCodec.ts'])(
    '%s reaches only files of the module at run time',
    (name) => {
      const { runtime } = importsOf(path.join(KV_DIR, name));

      for (const specifier of runtime) {
        expect(specifier, `${name} imports ${specifier}`).toMatch(/^\.\/[A-Za-z]+(\.js)?$/);
      }
    },
  );

  it('names the adapter contract for types only', () => {
    const { runtime, typesOnly } = importsOf(path.join(KV_DIR, 'sqlKeyValueStore.ts'));

    expect(typesOnly).toContain('../../core/contracts');
    expect(runtime.some((specifier) => specifier.includes('core') || specifier.includes('adapters'))).toBe(false);
  });
});
