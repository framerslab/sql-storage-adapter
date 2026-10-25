import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareVersions, planFromRepository, raisePatch, releaseNotes } from '../scripts/release-version.mjs';

// The release workflow's decision, made against a real git repository built for
// each spec and a registry that answers from a table as npm answers: the
// dist-tags document, and a version's document with its gitHead, or a 404.

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c', 'user.name=Release Spec',
      '-c', 'user.email=release-spec@example.invalid',
      '-c', 'commit.gpgsign=false',
      '-c', 'tag.gpgsign=false',
      ...args,
    ],
    { cwd: dir, encoding: 'utf8' },
  ).trim();
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-version-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'master']);
  return dir;
}

function commit(dir: string, files: Record<string, string>, message: string): string {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

const manifest = (version: string) => `${JSON.stringify({ name: '@framers/sql-storage-adapter', version }, null, 2)}\n`;

/** npm holding `published` (each version and the commit it was published from), `latest` its latest dist-tag. */
function registry(published: Record<string, string>, latest: string | null) {
  return async (url: string | URL): Promise<Response> => {
    const href = String(url);
    if (href.endsWith('/dist-tags')) {
      return latest === null ? new Response('{"error":"Not found"}', { status: 404 }) : Response.json({ latest });
    }
    const version = decodeURIComponent(href.slice(href.lastIndexOf('/') + 1));
    const gitHead = published[version];
    return gitHead
      ? Response.json({ name: '@framers/sql-storage-adapter', version, gitHead })
      : new Response(`"version not found: ${version}"`, { status: 404 });
  };
}

/** A repository whose first commit was published as 0.8.2 and tagged v0.8.2 by the release workflow. */
function releasedRepo(): { dir: string; released: string } {
  const dir = makeRepo();
  const released = commit(dir, { 'package.json': manifest('0.8.2'), 'src/index.ts': 'export const saves = 1;\n' }, 'feat: the adapter');
  git(dir, ['tag', 'v0.8.2', released]);
  return { dir, released };
}

describe('the release decision', () => {
  it('publishes the next patch when a shipped file changed though package.json names a published version', async () => {
    const { dir, released } = releasedRepo();
    commit(dir, { 'src/index.ts': 'export const saves = 2;\n' }, 'fix: a save keeps its writes');
    commit(dir, { 'docs/notes.md': 'notes\n' }, 'docs: notes the package does not ship');

    const plan = await planFromRepository({ cwd: dir, fetch: registry({ '0.8.2': released }, '0.8.2') });

    expect(plan).toMatchObject({ publish: true, version: '0.8.3', base: '0.8.2', baseCommit: released, release: '0.8.3' });
    expect(plan.releaseCommit).toBe(plan.head);
    const notes = releaseNotes({ cwd: dir, plan });
    expect(notes).toContain('fix: a save keeps its writes');
    expect(notes).not.toContain('docs: notes the package does not ship');
  });

  it('counts a change to README.md, LICENSE, package.json or the build as shipped', async () => {
    const changes: Record<string, string> = {
      'README.md': 'changed\n',
      LICENSE: 'changed\n',
      'package.json': `${JSON.stringify({ name: '@framers/sql-storage-adapter', version: '0.8.2', dependencies: { pg: '^8.20.0' } }, null, 2)}\n`,
      'tsconfig.build.json': '{}\n',
      'scripts/build-cjs.mjs': '// changed\n',
    };
    for (const [file, text] of Object.entries(changes)) {
      const { dir, released } = releasedRepo();
      commit(dir, { [file]: text }, `chore: ${file}`);

      const plan = await planFromRepository({ cwd: dir, fetch: registry({ '0.8.2': released }, '0.8.2') });

      expect(plan, file).toMatchObject({ publish: true, version: '0.8.3' });
    }
  });

  it('publishes nothing when only files the package does not ship changed', async () => {
    const { dir, released } = releasedRepo();
    commit(
      dir,
      { 'tests/saves.spec.ts': 'spec\n', '.github/workflows/ci.yml': 'on: push\n', 'CHANGELOG.md': '## [Unreleased]\n' },
      'test: a spec',
    );

    const plan = await planFromRepository({ cwd: dir, fetch: registry({ '0.8.2': released }, '0.8.2') });

    expect(plan.publish).toBe(false);
    expect(plan.reason).toContain('no file the package ships changed since v0.8.2');
  });

  it('publishes nothing from the commit the newest version was published from', async () => {
    const { dir, released } = releasedRepo();

    const plan = await planFromRepository({ cwd: dir, fetch: registry({ '0.8.2': released }, '0.8.2') });

    expect(plan.publish).toBe(false);
    expect(plan.reason).toContain('v0.8.2 was published from this commit');
  });

  it('publishes nothing on a re-run of a commit older than the newest version', async () => {
    const { dir, released } = releasedRepo();
    const older = commit(dir, { 'src/index.ts': 'export const saves = 2;\n' }, 'fix: one');
    const newer = commit(dir, { 'src/index.ts': 'export const saves = 3;\n' }, 'fix: two');
    git(dir, ['tag', 'v0.8.3', newer]);
    git(dir, ['checkout', '-q', older]);

    const plan = await planFromRepository({ cwd: dir, fetch: registry({ '0.8.2': released, '0.8.3': newer }, '0.8.3') });

    expect(plan.publish).toBe(false);
    expect(plan.reason).toContain('this commit is older than');
  });

  it("fails when the newest version was published from a commit this history does not hold", async () => {
    // Skipping would leave every later push unpublished behind a green run.
    const { dir, released } = releasedRepo();
    const side = commit(dir, { 'src/index.ts': 'export const saves = 9;\n' }, 'fix: on a branch');
    git(dir, ['tag', '-a', 'v0.8.3', '-m', 'v0.8.3', side]);
    git(dir, ['reset', '-q', '--hard', released]);
    commit(dir, { 'src/index.ts': 'export const saves = 2;\n' }, 'fix: on master');

    await expect(
      planFromRepository({ cwd: dir, fetch: registry({ '0.8.2': released, '0.8.3': side }, '0.8.3') }),
    ).rejects.toThrow("raise package.json's version above 0.8.3");
  });

  it('fails on a tag above every published version that this history does not hold', async () => {
    // A tag made by hand on another branch would otherwise hold every later push back.
    const { dir, released } = releasedRepo();
    const side = commit(dir, { 'src/index.ts': 'export const saves = 9;\n' }, 'fix: on a branch');
    git(dir, ['tag', 'v1.0.0', side]);
    git(dir, ['reset', '-q', '--hard', released]);
    commit(dir, { 'src/index.ts': 'export const saves = 2;\n' }, 'fix: on master');

    await expect(
      planFromRepository({ cwd: dir, fetch: registry({ '0.8.2': released }, '0.8.2') }),
    ).rejects.toThrow('v1.0.0');
  });

  it('reads an annotated tag as the commit it names', async () => {
    const dir = makeRepo();
    const released = commit(dir, { 'package.json': manifest('0.8.2'), 'src/index.ts': 'export const saves = 1;\n' }, 'feat: the adapter');
    git(dir, ['tag', '-a', 'v0.8.2', '-m', 'v0.8.2', released]);
    commit(dir, { 'src/index.ts': 'export const saves = 2;\n' }, 'fix: one');

    // npm names no gitHead here, so the commit can only come from the tag.
    const plan = await planFromRepository({ cwd: dir, fetch: registry({}, '0.8.2') });

    expect(plan).toMatchObject({ publish: true, version: '0.8.3', baseCommit: released });
  });

  it('publishes the version package.json names when it is above every published one', async () => {
    const { dir, released } = releasedRepo();
    commit(dir, { 'package.json': manifest('0.9.0') }, 'feat: a minor version');

    const plan = await planFromRepository({ cwd: dir, fetch: registry({ '0.8.2': released }, '0.8.2') });

    expect(plan).toMatchObject({ publish: true, version: '0.9.0', base: '0.8.2' });
  });

  it('counts from the newest tag while npm still names an older latest', async () => {
    // A run that published 0.8.3 made its tag at once; npm's dist-tags and
    // the version's own document can answer for the older state for minutes.
    const { dir, released } = releasedRepo();
    const second = commit(dir, { 'src/index.ts': 'export const saves = 2;\n' }, 'fix: one');
    git(dir, ['tag', 'v0.8.3', second]);
    commit(dir, { 'src/index.ts': 'export const saves = 3;\n' }, 'fix: two');

    const plan = await planFromRepository({ cwd: dir, fetch: registry({ '0.8.2': released }, '0.8.2') });

    expect(plan).toMatchObject({ publish: true, version: '0.8.4', base: '0.8.3', baseCommit: second });
  });

  it('passes over a version npm holds that no tag names', async () => {
    const { dir, released } = releasedRepo();
    commit(dir, { 'src/index.ts': 'export const saves = 2;\n' }, 'fix: one');

    const plan = await planFromRepository({
      cwd: dir,
      fetch: registry({ '0.8.2': released, '0.8.3': released }, '0.8.2'),
    });

    expect(plan).toMatchObject({ publish: true, version: '0.8.4' });
  });

  it("publishes nothing on a re-run of an older commit while npm's latest lags behind a newer commit's release", async () => {
    // 0.8.3 is tagged and npm's latest; 0.8.4 was just published from a later
    // commit, whose tag this older commit does not contain and which npm's
    // latest does not name yet.
    const { dir, released } = releasedRepo();
    const tagged = commit(dir, { 'src/index.ts': 'export const saves = 2;\n' }, 'fix: one');
    git(dir, ['tag', 'v0.8.3', tagged]);
    const older = commit(dir, { 'src/index.ts': 'export const saves = 3;\n' }, 'fix: two');
    const newer = commit(dir, { 'src/index.ts': 'export const saves = 4;\n' }, 'fix: three');
    git(dir, ['tag', 'v0.8.4', newer]);
    git(dir, ['checkout', '-q', older]);

    const plan = await planFromRepository({
      cwd: dir,
      fetch: registry({ '0.8.2': released, '0.8.3': tagged, '0.8.4': newer }, '0.8.3'),
    });

    expect(plan.publish).toBe(false);
    expect(plan.reason).toContain('this commit is older than');
  });

  it("counts from a version npm holds that no tag names, published from a commit this one does not contain", async () => {
    // As above, with the newer release's tag step failed as well: only npm's
    // version document names 0.8.4 and its commit.
    const { dir, released } = releasedRepo();
    const tagged = commit(dir, { 'src/index.ts': 'export const saves = 2;\n' }, 'fix: one');
    git(dir, ['tag', 'v0.8.3', tagged]);
    const older = commit(dir, { 'src/index.ts': 'export const saves = 3;\n' }, 'fix: two');
    const newer = commit(dir, { 'src/index.ts': 'export const saves = 4;\n' }, 'fix: three');
    git(dir, ['checkout', '-q', older]);

    const plan = await planFromRepository({
      cwd: dir,
      fetch: registry({ '0.8.2': released, '0.8.3': tagged, '0.8.4': newer }, '0.8.3'),
    });

    expect(plan.publish).toBe(false);
    expect(plan.reason).toContain('this commit is older than');
  });

  it('makes the missing GitHub release of a version published from this commit', async () => {
    // A run published 0.8.3 and failed before its release and tag; its re-run publishes nothing.
    const { dir, released } = releasedRepo();
    const published = commit(dir, { 'src/index.ts': 'export const saves = 2;\n' }, 'fix: one');

    const plan = await planFromRepository({
      cwd: dir,
      fetch: registry({ '0.8.2': released, '0.8.3': published }, '0.8.3'),
    });

    expect(plan).toMatchObject({ publish: false, release: '0.8.3', releaseCommit: published });
  });

  it('makes no release for a version whose tag exists', async () => {
    const { dir, released } = releasedRepo();

    const plan = await planFromRepository({ cwd: dir, fetch: registry({ '0.8.2': released }, '0.8.2') });

    expect(plan).toMatchObject({ publish: false, release: null });
  });

  it("finds the published commit from npm's gitHead when no tag names it", async () => {
    const dir = makeRepo();
    const released = commit(dir, { 'package.json': manifest('0.8.2'), 'src/index.ts': 'export const saves = 1;\n' }, 'feat: the adapter');
    commit(dir, { 'src/index.ts': 'export const saves = 2;\n' }, 'fix: one');

    const plan = await planFromRepository({ cwd: dir, fetch: registry({ '0.8.2': released }, '0.8.2') });

    expect(plan).toMatchObject({ publish: true, version: '0.8.3', baseCommit: released });
  });

  it('refuses when neither a tag nor npm names a commit of this repository for the newest version', async () => {
    const dir = makeRepo();
    commit(dir, { 'package.json': manifest('0.8.2'), 'src/index.ts': 'export const saves = 1;\n' }, 'feat: the adapter');

    await expect(
      planFromRepository({ cwd: dir, fetch: registry({ '0.8.2': 'f'.repeat(40) }, '0.8.2') }),
    ).rejects.toThrow('v0.8.2');
  });

  it("publishes package.json's version when nothing is published yet", async () => {
    const dir = makeRepo();
    commit(dir, { 'package.json': manifest('0.1.0'), 'src/index.ts': 'export const saves = 1;\n' }, 'feat: the adapter');

    const plan = await planFromRepository({ cwd: dir, fetch: registry({}, null) });

    expect(plan).toMatchObject({ publish: true, version: '0.1.0', base: null });
  });

  it('fails when the registry answers neither a document nor a 404', async () => {
    const { dir } = releasedRepo();
    const down = async () => new Response('Service Unavailable', { status: 503 });

    await expect(planFromRepository({ cwd: dir, fetch: down })).rejects.toThrow('503');
  });
});

describe('version order', () => {
  it('compares each part as a number and raises the patch past nine', () => {
    expect(compareVersions('0.8.10', '0.8.9')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(raisePatch('0.8.9')).toBe('0.8.10');
  });
});
