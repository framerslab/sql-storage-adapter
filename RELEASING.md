# Release Process

`@framers/sql-storage-adapter` publishes through the workflow at [`.github/workflows/release.yml`](https://github.com/framerslab/sql-storage-adapter/blob/master/.github/workflows/release.yml).

## What starts a release

Every push to `master`. A maintainer can also start the workflow by hand on `master`; started on another branch, it publishes nothing.

## What the workflow does

Its runs go one at a time, in the order they began to wait: a run that starts while another runs waits for it, and up to 100 wait, so a newer run never replaces one still waiting.

1. Decides what to publish, with [`scripts/release-version.mjs`](https://github.com/framerslab/sql-storage-adapter/blob/master/scripts/release-version.mjs), before it installs anything. The newest published version is the higher of npm's `latest` and the newest `v<x.y.z>` tag the pushed commit contains (a run's tag is read at once, while npm's `latest` can name the older version for minutes after a publish), and the commit it was published from is its tag's, or npm's `gitHead` for it.
   - When `package.json` names a version above the newest published one, that version is published.
   - Otherwise, when a file the package ships changed since that commit, the newest published version with its patch raised by one is published. The files it ships and builds from are `src/`, `package.json`, `README.md`, `LICENSE`, `tsconfig.json`, `tsconfig.build.json`, `scripts/fix-esm-imports.mjs` and `scripts/build-cjs.mjs`.
   - Otherwise nothing is published: a push that changed only the tests, the docs outside the package, `CHANGELOG.md` or CI publishes nothing, and so does a run of a commit older than the one the newest version was published from, such as a re-run.
   - A version npm already holds is passed over for the next patch.
   - A commit whose history does not hold the commit the newest version was published from fails the run, which says to raise `package.json`'s version above that version.
2. Installs the dependencies, runs the tests and builds the package.
3. Writes the version into its checkout's `package.json` and publishes the package to npm with a provenance statement. Nothing is committed to `master`: its `package.json` keeps the version a maintainer last named, while npm and the `v<version>` tags hold the published ones.
4. Creates the GitHub release `v<version>` on the published commit, with the notes of that version's `## [<version>]` section in `CHANGELOG.md`, or, when it has none, the commits since the previous version that changed what the package ships. The release creates the tag.

Each run's job summary says what it published, or why it published nothing.

## Releasing a version

A merged change to what the package ships needs no step: its push publishes the next patch.

For a new minor or major version, raise `version` in `package.json` in the pull request (semantic versioning: a breaking change raises the major version, a new feature the minor version) and add the version's section to `CHANGELOG.md`, headed `## [x.y.z]`. Its merge publishes that version.

A pull request's notes for `CHANGELOG.md` go under `## [Unreleased]`, which a maintainer heads with the version that published them.

Do not push a version tag by hand: the decision counts from the newest tag, so a tag above npm's versions moves every later version past it.

## How the publish authenticates

npm trusted publishing is configured for this package and `release.yml`: the job's OIDC token (`permissions: id-token: write`) is exchanged with the registry for a publish token. npm makes that exchange from version 11.5.1, so the job installs npm 11.20.0 before it publishes. A version published this way names GitHub Actions as its publisher on npm and carries a provenance statement. See [npm's trusted publishers page](https://docs.npmjs.com/trusted-publishers).

## Deprecating a version

To deprecate a published version, such as one that fails on a runtime it accepts, run the [Deprecate a version](https://github.com/framerslab/sql-storage-adapter/blob/master/.github/workflows/deprecate.yml) workflow by hand with the version and a message that says why and which version to use instead. To remove a version's mark, run it with clear ticked and no message. A published version is never unpublished, so every lockfile that names it stays installable.

## Required secrets

- `NPM_TOKEN`: an npm token with publish access to `@framers/sql-storage-adapter`. The release uses it only when the exchange fails; the Deprecate a version workflow uses it on every run, since the exchange covers `npm publish` alone ([npm's trusted publishers page](https://docs.npmjs.com/trusted-publishers)).

`GITHUB_TOKEN`, which GitHub Actions provides, creates the tag and the release.
