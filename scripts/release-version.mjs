#!/usr/bin/env node

// Decides what a push to master publishes, for .github/workflows/release.yml,
// which runs it before it installs anything: it uses Node's own modules alone.
//
// A push publishes when a file the package ships changed since the newest
// published version, or when package.json names a version above every
// published one. The version is package.json's in the second case and the
// newest published version with its patch raised by one in the first. The
// newest published version is the higher of npm's latest and the newest
// v<x.y.z> tag: a release run's tag is read at once, while npm's dist-tags can
// name the older latest for minutes after a publish. A version npm holds that
// neither names is found when the run would publish it, and the decision is
// made again from that version. A run of a commit older than the one the
// newest version was published from, such as a re-run, publishes nothing; a
// commit whose history does not hold that one fails the run.
//
// When no tag names the newest published version, the run makes its GitHub
// release and tag at the commit it was published from, beside any version it
// publishes: the repair of a run that published and failed before its release.
//
// The workflow writes the version into its own checkout's package.json alone:
// master's package.json keeps the version a maintainer last named.
//
// Only the run of master's head publishes: a run of an older commit, such as
// a re-run, publishes nothing, since master's head holds its changes and that
// commit's own run publishes them.
//
// Usage: node scripts/release-version.mjs [--notes <folder>]
// Writes publish, version, base, base_commit, release, release_commit, repair
// and repair_commit to $GITHUB_OUTPUT and the decision to the job summary, and
// with --notes the release notes to <folder>/release.md and <folder>/repair.md.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org';

/**
 * What the package ships and what it is built from: package.json's files
 * (dist, which the build makes from src through tsconfig.build.json and the
 * two build scripts) and the files npm adds to every package.
 */
export const SHIPPED_PATHS = [
  'src',
  'package.json',
  'README.md',
  'LICENSE',
  'tsconfig.json',
  'tsconfig.build.json',
  'scripts/fix-esm-imports.mjs',
  'scripts/build-cjs.mjs',
];

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const parts = (version) => version.match(VERSION).slice(1).map(Number);

/** Orders two x.y.z versions, each part as a number. */
export function compareVersions(a, b) {
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export function raisePatch(version) {
  const [major, minor, patch] = parts(version);
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * The decision, from what the repository and the registry answer. Resolves to
 * { publish, version, base, baseCommit, release, releaseCommit, repair,
 * repairCommit, reason }: base is the newest published version and baseCommit
 * the commit it was published from; release is the version this run publishes,
 * whose GitHub release and tag it makes at releaseCommit; repair is the newest
 * published version when no tag names it (a run that published and failed
 * before its release), whose release and tag it makes at repairCommit.
 *
 * tip is master's head when the run decides: a run of an older commit
 * publishes nothing, since the tip's own run carries its changes. commitOf
 * (version) resolves to { commit, tagged } or null.
 */
export async function planRelease({ packageVersion, latest, tagVersions, head, tip, commitOf, isAncestor, shippedChanged, isPublished }) {
  const skipped = { publish: false, version: null, base: null, baseCommit: null, release: null, releaseCommit: null, repair: null, repairCommit: null };
  if (tip && tip !== head) {
    if (await isAncestor(head, tip)) {
      return { ...skipped, reason: `master has moved past this commit to ${tip.slice(0, 8)}, whose own run publishes this one's changes` };
    }
    throw new Error(`master's tip ${tip.slice(0, 8)} does not hold this commit ${head.slice(0, 8)}: only master publishes`);
  }

  const named = VERSION.test(packageVersion ?? '') ? packageVersion : null;
  const newest = [latest, ...tagVersions]
    .filter((version) => typeof version === 'string' && VERSION.test(version))
    .reduce((top, version) => (top === null || compareVersions(version, top) > 0 ? version : top), null);

  // Publishes `version` unless npm holds it already. A version npm holds that
  // neither its latest nor a tag named is a newer published version: the
  // decision is made again from it, so a run never publishes past a version
  // whose commit it has not compared with its own.
  const publishOrCount = async (version, reason, base, baseCommit, steps, repairs) => {
    if (!(await isPublished(version))) {
      return { publish: true, version, base, baseCommit, release: version, releaseCommit: head, ...repairs, reason };
    }
    return decideFrom(version, steps + 1);
  };

  const decideFrom = async (base, steps) => {
    if (steps > 50) throw new Error(`npm holds 50 versions after the newest one a tag or npm's latest names`);
    const found = await commitOf(base);
    if (found === null) {
      throw new Error(
        `npm holds ${base}, but neither a v${base} tag nor npm's gitHead for it names a commit of this repository`,
      );
    }
    const baseCommit = found.commit;
    const repairs = found.tagged ? { repair: null, repairCommit: null } : { repair: base, repairCommit: baseCommit };
    const nothing = (reason) => ({ ...skipped, base, baseCommit, ...repairs, reason });

    if (named !== null && compareVersions(named, base) > 0) {
      return publishOrCount(named, `package.json names ${named}, above v${base}`, base, baseCommit, steps, repairs);
    }
    if (baseCommit === head) return nothing(`v${base} was published from this commit`);
    if (!(await isAncestor(baseCommit, head))) {
      if (await isAncestor(head, baseCommit)) {
        return nothing(`this commit is older than ${baseCommit.slice(0, 8)}, which v${base} was published from`);
      }
      // Skipping here would leave every later push unpublished behind a green run.
      throw new Error(
        `v${base} names ${baseCommit.slice(0, 8)} (its tag, or npm's gitHead for it), which this commit's history does not hold; raise package.json's version above ${base} to publish from this history, or delete the tag if npm holds no such version`,
      );
    }
    if (!(await shippedChanged(baseCommit, head))) return nothing(`no file the package ships changed since v${base}`);
    return publishOrCount(raisePatch(base), `files the package ships changed since v${base}`, base, baseCommit, steps, repairs);
  };

  if (newest === null) {
    if (named === null) {
      throw new Error(`package.json's version ${packageVersion} is not x.y.z, and npm holds no version to count from`);
    }
    const first = `npm holds no version yet, so package.json's ${named} is the first`;
    return publishOrCount(named, first, null, null, 0, { repair: null, repairCommit: null });
  }
  return decideFrom(newest, 0);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function gitOutput(cwd, args) {
  const result = git(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** git's answer to a yes-or-no question: exit 0 is yes, exit 1 is no, anything else a failure. */
function gitAnswers(cwd, args) {
  const result = git(cwd, args);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
}

/**
 * The decision for the repository at `cwd`, asking `registry` through `fetch`;
 * `tip` is master's head (left out, no run counts as older than master).
 */
export async function planFromRepository({ cwd, fetch, registry = REGISTRY, tip = null }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const escaped = pkg.name.replace('/', '%2f');

  // A document's text, or null for npm's 404. Any other answer fails the run,
  // so a registry outage never reads as "not published".
  const read = async (url) => {
    const response = await fetch(url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.text();
  };
  const versionDocument = (version) => read(`${registry}/${escaped}/${version}`);

  const distTags = await read(`${registry}/-/package/${escaped}/dist-tags`);
  const head = gitOutput(cwd, ['rev-parse', 'HEAD']);
  // Every tag, not only those this commit contains: a newer commit's tag is
  // what tells a re-run of an older commit that it is older.
  const tagVersions = gitOutput(cwd, ['tag', '--list', 'v*'])
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .map((tag) => tag.slice(1));

  const plan = await planRelease({
    packageVersion: pkg.version,
    latest: distTags === null ? null : (JSON.parse(distTags).latest ?? null),
    tagVersions,
    head,
    tip,
    commitOf: async (version) => {
      const tag = git(cwd, ['rev-parse', '-q', '--verify', `refs/tags/v${version}^{commit}`]);
      if (tag.status === 0) return { commit: tag.stdout.trim(), tagged: true };
      // A version's document can carry a README that JSON.parse refuses, so gitHead is read on its own.
      const gitHead = (await versionDocument(version))?.match(/"gitHead"\s*:\s*"([0-9a-f]{40})"/)?.[1];
      if (gitHead && git(cwd, ['cat-file', '-e', `${gitHead}^{commit}`]).status === 0) return { commit: gitHead, tagged: false };
      return null;
    },
    isAncestor: async (ancestor, commit) => gitAnswers(cwd, ['merge-base', '--is-ancestor', ancestor, commit]),
    shippedChanged: async (from, to) => !gitAnswers(cwd, ['diff', '--quiet', from, to, '--', ...SHIPPED_PATHS]),
    isPublished: async (version) => (await versionDocument(version)) !== null,
  });
  return { ...plan, head, name: pkg.name };
}

/** The version's section of CHANGELOG.md, headed `## [<version>]`, or null. */
function changelogSection(cwd, version) {
  let text;
  try {
    text = fs.readFileSync(path.join(cwd, 'CHANGELOG.md'), 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## ['));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim() || null;
}

/**
 * A GitHub release's notes. For the version the run publishes (`which` is
 * 'release'): its section of CHANGELOG.md, or else the commits since the base
 * version that changed what the package ships. For the repaired version
 * ('repair'): its section, or a line naming the commit it was published from.
 */
export function releaseNotes({ cwd, plan, which = 'release', repository = null }) {
  if (which === 'repair') {
    return `${changelogSection(cwd, plan.repair) ?? `v${plan.repair} as npm holds it, published from ${plan.repairCommit}.`}\n`;
  }
  const section = changelogSection(cwd, plan.release);
  if (section) return `${section}\n`;
  if (plan.baseCommit === null) return `The first release of ${plan.name}.\n`;
  const commits = gitOutput(cwd, ['log', '--no-merges', '--format=- %s (%h)', `${plan.baseCommit}..${plan.head}`, '--', ...SHIPPED_PATHS]);
  const compare = repository ? `\n\nEvery change: ${repository}/compare/v${plan.base}...v${plan.version}` : '';
  return `The commits since v${plan.base} that changed what the package ships:\n\n${commits}${compare}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const notesAt = argv.indexOf('--notes');
  const notesDir = notesAt === -1 ? null : argv[notesAt + 1];
  if (notesAt !== -1 && !notesDir) throw new Error('--notes needs a folder');

  const cwd = process.cwd();
  // master's head now, read from the remote: the repository is public, so this
  // needs no credential.
  const tip = gitOutput(cwd, ['ls-remote', 'origin', 'refs/heads/master']).split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(tip ?? '')) throw new Error(`git ls-remote named no master head (${tip || 'empty'})`);
  const plan = await planFromRepository({ cwd, fetch: globalThis.fetch, tip });
  const repair = plan.repair ? ` No tag names v${plan.repair}: making its GitHub release.` : '';
  const line = plan.publish ? `Publishing ${plan.version}: ${plan.reason}.${repair}` : `Publishing nothing: ${plan.reason}.${repair}`;
  console.log(line);

  const outputs = {
    publish: String(plan.publish),
    version: plan.version ?? '',
    base: plan.base ?? '',
    base_commit: plan.baseCommit ?? '',
    release: plan.release ?? '',
    release_commit: plan.releaseCommit ?? '',
    repair: plan.repair ?? '',
    repair_commit: plan.repairCommit ?? '',
  };
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (notesDir) {
    const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo } = process.env;
    const repository = server && repo ? `${server}/${repo}` : null;
    if (plan.release) fs.writeFileSync(path.join(notesDir, 'release.md'), releaseNotes({ cwd, plan, repository }));
    if (plan.repair) fs.writeFileSync(path.join(notesDir, 'repair.md'), releaseNotes({ cwd, plan, which: 'repair' }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
