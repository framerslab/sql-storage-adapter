import { defineConfig } from 'vitest/config';

// The specs under tests/browser run in Chromium, WebKit and Firefox through
// Playwright, on the browsers' own IndexedDB, Web Locks and structured clone.
// CI installs the three browsers first:
// npx playwright install --with-deps chromium webkit firefox.
export default defineConfig({
  optimizeDeps: {
    // Bundled before the first spec runs, so no spec reloads the page mid-run.
    include: ['sql.js'],
  },
  test: {
    include: ['tests/browser/**/*.browser.spec.ts'],
    testTimeout: 30_000,
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      screenshotFailures: false,
      instances: [{ browser: 'chromium' }, { browser: 'webkit' }, { browser: 'firefox' }],
    },
  },
});
