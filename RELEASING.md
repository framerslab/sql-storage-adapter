# Release Process

`@framers/sql-storage-adapter` publishes through the workflow at [`.github/workflows/release.yml`](https://github.com/framerslab/sql-storage-adapter/blob/master/.github/workflows/release.yml).

## What starts a release

A push to `master` that changes `package.json`, a file under `src/` or the workflow. A maintainer can also start the workflow by hand.

## What the workflow does

Its runs go one at a time, in the order they began to wait: a run that starts while another runs waits for it, and up to 100 wait, so a newer run never replaces one still waiting.

1. Installs the dependencies, runs the tests and builds the package.
2. Reads the version in `package.json` and asks npm whether it holds that exact version.
3. When npm does not, publishes the package to npm.
4. Creates the GitHub release `v<version>`, with the notes of that version's `## [<version>]` section in `CHANGELOG.md`, unless a release with that tag exists. The release creates the tag.

A push whose version npm already has publishes nothing.

## Releasing a version

1. Raise `version` in `package.json` (semantic versioning: a breaking change raises the major version, a new feature the minor version, a fix the patch version).
2. Add the version's section to `CHANGELOG.md`, headed `## [x.y.z]`.
3. Merge both to `master` through a pull request with green CI.

Do not push a version tag by hand.

## How the publish authenticates

npm trusted publishing is configured for this package and `release.yml`: the job's OIDC token (`permissions: id-token: write`) is exchanged with the registry for a publish token. npm makes that exchange from version 11.5.1, so the job installs npm 11.20.0 before it publishes. A version published this way names GitHub Actions as its publisher on npm and carries a provenance statement. See [npm's trusted publishers page](https://docs.npmjs.com/trusted-publishers).

## Deprecating a version

To deprecate a published version, such as one that fails on a runtime it accepts, run the [Deprecate a version](https://github.com/framerslab/sql-storage-adapter/blob/master/.github/workflows/deprecate.yml) workflow by hand with the version and a message that says why and which version to use instead. To remove a version's mark, run it with clear ticked and no message. A published version is never unpublished, so every lockfile that names it stays installable.

## Required secrets

- `NPM_TOKEN`: an npm token with publish access to `@framers/sql-storage-adapter`. The release uses it only when the exchange fails; the Deprecate a version workflow uses it on every run, since the exchange covers `npm publish` alone ([npm's trusted publishers page](https://docs.npmjs.com/trusted-publishers)).

`GITHUB_TOKEN`, which GitHub Actions provides, creates the tag and the release.
