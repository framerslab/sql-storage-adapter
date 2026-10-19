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

## Workflows never push to master

`master`'s rules refuse a direct push, so no workflow pushes a commit to it: a step that changes the repository pushes a branch of its own and opens a pull request, or writes to a branch the rules leave open. The `build` job runs [`.github/scripts/check-workflow-pushes.mjs`](.github/scripts/check-workflow-pushes.mjs), which fails the pull request that adds such a push: a `git push` to `master`, or to the branch the run is on from a workflow that runs on `master`, an action that pushes there, or a semantic-release run while `release.config.js` lists `@semantic-release/git`. It reads the YAML with [mikefarah's yq](https://github.com/mikefarah/yq) v4, which GitHub's Ubuntu runners carry; run it elsewhere with `yq` on the path, or `YQ` naming it: `node .github/scripts/check-workflow-pushes.mjs`.

## Required secrets

- `NPM_TOKEN`: an npm token with publish access to `@framers/sql-storage-adapter`.

`GITHUB_TOKEN`, which GitHub Actions provides, creates the tag and the release.
