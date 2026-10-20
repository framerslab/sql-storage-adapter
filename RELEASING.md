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

`master`'s rules refuse a direct push, so no workflow pushes a commit to it: a step that changes the repository pushes a branch of its own and opens a pull request, or writes to a branch the rules leave open. The `build` job runs [`.github/scripts/check-workflow-pushes.mjs`](.github/scripts/check-workflow-pushes.mjs), which fails the pull request that adds such a push: a `git push` to `master` (named, or sent there by a `push.default` or `remote.<name>.push` setting), or to the branch the run is on from a workflow that runs on `master` (a merged pull request's `closed` run is on the branch it went into), one of the push actions it knows (`peaceiris/actions-gh-pages`, `JamesIves/github-pages-deploy-action`, `ad-m/github-push-action`, `stefanzweifel/git-auto-commit-action`, `EndBug/add-and-commit`) pushing there (a deploy action whose repository input names another repository is left to that repository's rules), or a semantic-release run while `release.config.js` lists `@semantic-release/git`. It reads a command where the shell runs it, in a substitution, an `sh -c` string, an `eval` or text piped or fed to a shell; follows the checked-out branch of each checkout (the root's, and one `actions/checkout` makes at a `path`) for each git command in the checkout its directory is in: the step's `working-directory`, then the script's `cd` and `pushd` (a subshell, a substitution, a command of a pipeline and a background job change directory for themselves alone, and a function's body where the function is called), `env -C`, `git -C`, `--git-dir` and `GIT_DIR` (set before the command, or in the `env:` of its step, job or workflow; `env -i` and `env -u` remove it, and through `sudo` without `-E` the checkout is one it cannot tell), or a push action's directory input; a command whose directory it cannot tell is read in every checkout. It follows the branch through `&&`, `||`, `if`, `case`, loops and steps with an `if:` condition (any of which may not run) and into the local composite actions a job calls (`uses: ./<path>`, with the inputs its `with:` gives, else their defaults; an input in a step's `if:` is a string, so an input of `false` there still runs the step); reads `git push` options as git does (`--dry-run --no-dry-run` pushes, `--mir` is `--mirror`); and reads `git config` as git does: in the checkout it runs in, with `--global` and `--system` beneath every checkout's own, and `--unset` removing only the value its pattern matches. A script a shell reads from a file, a variable or a download, a git setting made through `GIT_CONFIG_*` variables or a config file, a `GIT_DIR` a script sets, exports or unsets, a checkout `git clone` or `git worktree add` makes, and a push made by another action, are not read. It reads the YAML with [mikefarah's yq](https://github.com/mikefarah/yq) v4, which GitHub's Ubuntu runners carry; run it elsewhere with `yq` on the path, or `YQ` naming it: `node .github/scripts/check-workflow-pushes.mjs`.

## Required secrets

- `NPM_TOKEN`: an npm token with publish access to `@framers/sql-storage-adapter`.

`GITHUB_TOKEN`, which GitHub Actions provides, creates the tag and the release.
