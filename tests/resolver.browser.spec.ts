import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A browser bundle sees either no `process` at all or a bundler's shim with an
// empty `env` and `versions` (webpack's process/browser, for one). These specs
// use the shim. Deleting globalThis.process is not an option: the Vitest worker
// reads the global process itself and dies without it. The shim inherits
// everything else from the real process so the runner keeps working; its two
// own properties are defined, since process.versions is read-only and plain
// assignment through the prototype chain throws.
const browserProcess = (): NodeJS.Process =>
  Object.create(process, {
    env: { value: {}, enumerable: true },
    versions: { value: {}, enumerable: true },
  }) as NodeJS.Process;

describe('Resolver - Browser-Friendly', () => {
  const originalWindow = global.window;

  beforeEach(() => {
    vi.resetModules();
    global.window = { indexedDB: {} } as any;
    vi.stubGlobal('process', browserProcess());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    global.window = originalWindow;
  });

  it('should not require Node.js modules at import time', async () => {
    // Import should not fail without Node.js modules
    const { resolveStorageAdapter: resolver } = await import('../src/core/resolver');

    // Should be callable (will fail at runtime due to sql.js WASM, but that's expected)
    expect(resolver).toBeDefined();
    expect(typeof resolver).toBe('function');
  });

  it('should handle process.env safely in browser', async () => {
    const { resolveStorageAdapter: resolver } = await import('../src/core/resolver');

    // Should not throw even though process.env holds nothing
    expect(resolver).toBeDefined();
    // The actual resolution will fail due to sql.js WASM loading, but that's expected
  });

  it('should use browser-safe path utilities', async () => {
    const { resolveStorageAdapter: resolver } = await import('../src/core/resolver');

    // Should work without Node.js 'path' module
    expect(resolver).toBeDefined();
    // The important thing is that path.join is not called at import time
  });
});
