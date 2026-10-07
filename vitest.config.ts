import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/shims.d.ts',
        'node_modules/**',
        // Electron adapters require native bindings (better-sqlite3)
        'src/adapters/electron/**'
      ],
      thresholds: {
        statements: 1,
        branches: 1,
        functions: 1,
        lines: 1
      }
    },
    include: ['tests/**/*.{test,spec}.{js,ts}'],
    exclude: [
      'node_modules',
      'dist',
      'coverage'
      // better-sqlite3 is a dev dependency, so its suites run here. Without the
      // native module, betterSqliteAdapter.spec skips itself and the dataExport,
      // dataImport and migration specs fall back to sql.js.
    ]
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});