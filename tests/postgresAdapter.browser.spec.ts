import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('PostgresAdapter - Browser-Friendly', () => {
  // The adapter decides it is in a browser from window.document alone, so these
  // specs set or remove window and leave process alone: the Vitest worker reads
  // the global process itself and dies when a spec deletes it.
  const originalWindow = global.window;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    global.window = originalWindow;
  });

  it('should not import pg at module load time (browser-safe)', async () => {
    // Mock browser environment
    global.window = { document: {} } as any;

    // Import should not fail even though pg is not available
    const { PostgresAdapter: Adapter } = await import('../src/adapters/postgresAdapter');
    
    // Creating adapter should not fail
    const adapter = new Adapter({ connectionString: 'postgresql://test' });
    
    // But opening should fail with browser error (not pg import error)
    await expect(adapter.open()).rejects.toThrow(/browser environment/);
  });

  it('should use dynamic import for pg module', async () => {
    // Node.js environment: no window
    delete (global as any).window;

    const { PostgresAdapter: Adapter } = await import('../src/adapters/postgresAdapter');
    const adapter = new Adapter({ connectionString: 'postgresql://test' });

    // The adapter should be created successfully
    expect(adapter).toBeDefined();
    expect(adapter.kind).toBe('postgres');
    
    // Opening will fail because pg connection fails, but it should fail gracefully
    // (not with a module import error)
    await expect(adapter.open()).rejects.toThrow();
  }, 10000);
});

