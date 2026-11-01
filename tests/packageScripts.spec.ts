import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The build runs the TypeScript compiler this package installs, never `npx tsc`.
// Inside a workspace (the voice-chat-assistant monorepo lists packages/* as npm
// workspaces) npx looks for `tsc` in the workspace root's node_modules/.bin and
// above, not in this package's own. pnpm links the root's bins only after the
// workspace packages' prepare scripts have started, so a prepare that reached
// npx first found no tsc, fetched the npm package named `tsc` (a decoy that
// prints "This is not the tsc command you are looking for") and failed the
// install (voice-chat-assistant Release run 41275321236, 1 November 2026).
// `npm run` puts this package's node_modules/.bin on PATH, so a bare `tsc` is
// the typescript devDependency.

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
) as { scripts: Record<string, string>; devDependencies: Record<string, string> };

describe('package scripts', () => {
  it('the build, prepare and prepublish scripts call no compiler through npx', () => {
    for (const name of ['build', 'prepare', 'prepublishOnly', 'typecheck']) {
      expect(pkg.scripts[name], name).toBeDefined();
      expect(pkg.scripts[name], name).not.toMatch(/\bnpx\s+(--\S+\s+)*tsc\b/);
    }
  });

  it('the build runs tsc, which the typescript devDependency provides', () => {
    expect(pkg.scripts.build).toMatch(/(^|&&\s*)tsc -p tsconfig\.build\.json/);
    expect(pkg.devDependencies.typescript).toBeDefined();
  });
});
