#!/usr/bin/env node

// Decides what a push to master publishes, for .github/workflows/release.yml,
// which runs it before it installs anything: it uses Node's own modules alone.
//
// A push publishes when a file the package ships changed since the newest
// published version, or when package.json names a version above every
// published one. The version is package.json's in the second case and the
// newest published version with its patch raised by one in the first, and a
// version npm already holds is passed over. The newest published version is
// the higher of npm's latest and the newest v<x.y.z> tag this commit contains:
// a release run's tag is read at once, while npm's dist-tags can name the
// older latest for minutes after a publish. A run of a commit older than the
// one that version was published from, such as a re-run, publishes nothing;
// a commit whose history does not hold that one fails the run.
//
// The workflow writes the version into its own checkout's package.json alone:
// master's package.json keeps the version a maintainer last named.
//
// Usage: node scripts/release-version.mjs [--notes <file>]
// Writes publish, version, base and base_commit to $GITHUB_OUTPUT and the
// decision to the job summary, and with --notes the release notes to <file>.

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

/** `version`, or the first patch after it that npm does not hold. */
async function firstUnpublished(version, isPublished) {
  let candidate = version;
  for (let tries = 0; tries < 50; tries += 1) {
    if (!(await isPublished(candidate))) return candidate;
    candidate = raisePatch(candidate);
  }
  throw new Error(`npm holds ${version} and the 49 patches after it`);
}

/**
 * The decision, from what the repository and the registry answer. Resolves to
 * { publish, version, base, baseCommit, reason }: base is the newest published
 * version and baseCommit the commit it was published from.
 */
export async function planRelease({ packageVersion, latest, tagVersions, head, commitOf, isAncestor, shippedChanged, isPublished }) {
  const named = VERSION.test(packageVersion ?? '') ? packageVersion : null;
  const base = [latest, ...tagVersions]
    .filter((version) => typeof version === 'string' && VERSION.test(version))
    .reduce((newest, version) => (newest === null || compareVersions(version, newest) > 0 ? version : newest), null);

  const publishing = async (wanted, baseCommit, reason) => {
    const version = await firstUnpublished(wanted, isPublished);
    const passed = version === wanted ? '' : `; npm holds ${wanted}, so ${version}`;
    return { publish: true, version, base, baseCommit, reason: `${reason}${passed}` };
  };

  if (base === null) {
    if (named === null) {
      throw new Error(`package.json's version ${packageVersion} is not x.y.z, and npm holds no version to count from`);
    }
    return publishing(named, null, `npm holds no version yet, so package.json's ${named} is the first`);
  }

  const baseCommit = await commitOf(base);
  if (baseCommit === null) {
    throw new Error(
      `v${base} is the newest published version, but neither a v${base} tag nor npm's gitHead for it names a commit of this repository`,
    );
  }
  const nothing = (reason) => ({ publish: false, version: null, base, baseCommit, reason });

  if (named !== null && compareVersions(named, base) > 0) {
    return publishing(named, baseCommit, `package.json names ${named}, above v${base}`);
  }
  if (baseCommit === head) return nothing(`v${base} was published from this commit`);
  if (!(await isAncestor(baseCommit, head))) {
    if (await isAncestor(head, baseCommit)) {
      return nothing(`this commit is older than ${baseCommit.slice(0, 8)}, which v${base} was published from`);
    }
    // Skipping here would leave every later push unpublished with a green run.
    throw new Error(
      `v${base} was published from ${baseCommit.slice(0, 8)}, which this commit's history does not hold; raise package.json's version above ${base} to publish from this history`,
    );
  }
  if (!(await shippedChanged(baseCommit, head))) return nothing(`no file the package ships changed since v${base}`);
  return publishing(raisePatch(base), baseCommit, `files the package ships changed since v${base}`);
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

/** The decision for the repository at `cwd`, asking `registry` through `fetch`. */
export async function planFromRepository({ cwd, fetch, registry = REGISTRY }) {
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
  const tagVersions = gitOutput(cwd, ['tag', '--list', 'v*', '--merged', 'HEAD'])
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .map((tag) => tag.slice(1));

  const plan = await planRelease({
    packageVersion: pkg.version,
    latest: distTags === null ? null : (JSON.parse(distTags).latest ?? null),
    tagVersions,
    head,
    commitOf: async (version) => {
      const tagged = git(cwd, ['rev-parse', '-q', '--verify', `refs/tags/v${version}^{commit}`]);
      if (tagged.status === 0) return tagged.stdout.trim();
      // A version's document can carry a README that JSON.parse refuses, so gitHead is read on its own.
      const gitHead = (await versionDocument(version))?.match(/"gitHead"\s*:\s*"([0-9a-f]{40})"/)?.[1];
      if (gitHead && git(cwd, ['cat-file', '-e', `${gitHead}^{commit}`]).status === 0) return gitHead;
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
 * The GitHub release's notes: the version's section of CHANGELOG.md, or else
 * the commits since the base version that changed what the package ships.
 */
export function releaseNotes({ cwd, plan, repository = null }) {
  const section = changelogSection(cwd, plan.version);
  if (section) return `${section}\n`;
  if (plan.baseCommit === null) return `The first release of ${plan.name}.\n`;
  const commits = gitOutput(cwd, ['log', '--no-merges', '--format=- %s (%h)', `${plan.baseCommit}..${plan.head}`, '--', ...SHIPPED_PATHS]);
  const compare = repository ? `\n\nEvery change: ${repository}/compare/v${plan.base}...v${plan.version}` : '';
  return `The commits since v${plan.base} that changed what the package ships:\n\n${commits}${compare}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const notesAt = argv.indexOf('--notes');
  const notesFile = notesAt === -1 ? null : argv[notesAt + 1];
  if (notesAt !== -1 && !notesFile) throw new Error('--notes needs a file');

  const cwd = process.cwd();
  const plan = await planFromRepository({ cwd, fetch: globalThis.fetch });
  const line = plan.publish ? `Publishing ${plan.version}: ${plan.reason}.` : `Publishing nothing: ${plan.reason}.`;
  console.log(line);

  const outputs = { publish: String(plan.publish), version: plan.version ?? '', base: plan.base ?? '', base_commit: plan.baseCommit ?? '' };
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (plan.publish && notesFile) {
    const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo } = process.env;
    fs.writeFileSync(notesFile, releaseNotes({ cwd, plan, repository: server && repo ? `${server}/${repo}` : null }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
