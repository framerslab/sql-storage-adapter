import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// A browser bundle from webpack 5 has no `process` at all unless a shim is
// added (webpack 5 removed the automatic `node.process` polyfill), so the
// resolver and every module it imports must load without one. The Vitest
// worker cannot run without its own `process` (resolver.browser.spec.ts says
// why), so these modules run in a `vm` context that has none: each is
// transpiled to CommonJS, the Node built-ins and sql.js are empty modules, as a
// bundler's browser build makes them (`resolve.fallback: { fs: false }`), and
// the globals are the ones a browser page has.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** The modules a browser build replaces with empty ones. */
const EMPTY_IN_BROWSER = new Set(['fs', 'path', 'node:crypto', 'sql.js']);

/** A browser page's globals, with `window` as the global object and no `process`. */
function browserContext(): vm.Context {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    atob,
    btoa,
    crypto: globalThis.crypto,
    document: {},
    indexedDB: {},
  });
  vm.runInContext('globalThis.window = globalThis;', context);
  return context;
}

/** The source file a relative specifier names, as TypeScript resolves `./x.js` to `./x.ts`. */
function resolveSource(fromDir: string, specifier: string): string {
  const base = path.resolve(fromDir, specifier).replace(/\.js$/, '');
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${fromDir}`);
}

/**
 * Loads `entry` and every module it imports into `context`. A bare import
 * other than the empty browser modules fails the load, as it would leave a
 * browser bundle unresolved.
 */
function loadInto(context: vm.Context, entry: string): Record<string, unknown> {
  const loaded = new Map<string, { exports: Record<string, unknown> }>();
  const load = (file: string): Record<string, unknown> => {
    const cached = loaded.get(file);
    if (cached) return cached.exports;
    const module = { exports: {} as Record<string, unknown> };
    loaded.set(file, module);
    const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    });
    // A bundler gives import.meta.url its value at build time; CommonJS has no import.meta.
    const code = outputText.replace(/import\.meta\.url/g, JSON.stringify(`file://${file}`));
    const wrapper = vm.runInContext(`(function (exports, require, module) {\n${code}\n})`, context, { filename: file });
    const requireFrom = (specifier: string): unknown => {
      if (EMPTY_IN_BROWSER.has(specifier)) return {};
      if (!specifier.startsWith('.')) {
        throw new Error(`${path.relative(SRC, file)} imports ${specifier} when it loads`);
      }
      return load(resolveSource(path.dirname(file), specifier));
    };
    wrapper(module.exports, requireFrom, module);
    return module.exports;
  };
  return load(entry);
}

describe('Resolver - a browser bundle with no process', () => {
  const temporary: string[] = [];

  afterEach(() => {
    for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads the resolver and every module it imports in a context that has no process', () => {
    const context = browserContext();
    // The precondition: nothing in the context defines process.
    expect(vm.runInContext('typeof process', context)).toBe('undefined');

    const resolver = loadInto(context, path.join(SRC, 'core/resolver.ts'));

    expect(typeof resolver.resolveStorageAdapter).toBe('function');
  });

  it('fails a module that reads process when it loads, as the bundle would', () => {
    // The check itself: without it, a harness that never ran the code would pass.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-no-process-'));
    temporary.push(dir);
    fs.writeFileSync(path.join(dir, 'debug.ts'), "export const debug = process.env.SQL_ADAPTER_DEBUG === '1';\n");

    expect(() => loadInto(browserContext(), path.join(dir, 'debug.ts'))).toThrow('process is not defined');
  });
});
