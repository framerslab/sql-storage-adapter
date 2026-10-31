# Release Process

`@framers/sql-storage-adapter` publishes through the workflow at [`.github/workflows/release.yml`](https://github.com/framerslab/sql-storage-adapter/blob/master/.github/workflows/release.yml).

## What starts a release

Every push to `master`. A maintainer can also start the workflow by hand on `master`; started on another branch, it publishes nothing.

## What the workflow does

Its runs go one at a time, in the order they began to wait: a run that starts while another runs waits for it, and up to 100 wait, so a newer run never replaces one still waiting.

1. Decides what to publish, with [`scripts/release-version.mjs`](https://github.com/framerslab/sql-storage-adapter/blob/master/scripts/release-version.mjs), before it installs anything. Only the run of master's head decides: a run of an older commit (a re-run, or a push master moved past while the run waited) publishes nothing, since master's head holds its changes and that commit's own run publishes them. The newest published version is the highest of the versions npm holds and the `v<x.y.z>` tags (a run's tag is read at once, while npm's documents can name the older state for minutes after a publish), and the commit it was published from is its tag's, or npm's `gitHead` for it.
   - When `package.json` names a version above the newest published one, that version is published.
   - Otherwise, when a file the package ships changed since that commit, the newest published version with its patch raised by one is published. The files it ships and builds from are `src/`, `package.json`, `README.md`, `LICENSE`, `tsconfig.json`, `tsconfig.build.json`, `scripts/fix-esm-imports.mjs` and `scripts/build-cjs.mjs`.
   - Otherwise nothing is published: a push that changed only the tests, the docs outside the package, `CHANGELOG.md` or CI publishes nothing.
   - When npm already holds the version the run would publish, that version is the newest published one and the decision is made again from its commit, so a run never publishes past a version it has not compared with its own commit.
   - A commit whose history does not hold the commit the newest version was published from fails the run, which says to raise `package.json`'s version above that version, or to delete a tag npm holds no version for.
   - When no tag names the newest published version (a run published it and failed before its release), the run makes that version's GitHub release and tag at the commit it was published from, beside any version it publishes.
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

## Workflows never push to master

`master`'s rules refuse a direct push, so no workflow pushes a commit to it: a step that changes the repository pushes a branch of its own and opens a pull request, or writes to a branch the rules leave open. The `build` job runs [`.github/scripts/check-workflow-pushes.mjs`](.github/scripts/check-workflow-pushes.mjs), which fails the pull request that adds such a push: a `git push` to `master` (named, or sent there by a `push.default` or `remote.<name>.push` setting), or to the branch the run is on from a workflow that runs on `master` (a merged pull request's `closed` run is on the branch it went into), one of the push actions it knows (`peaceiris/actions-gh-pages`, `JamesIves/github-pages-deploy-action`, `ad-m/github-push-action`, `stefanzweifel/git-auto-commit-action`, `EndBug/add-and-commit`) pushing there (a deploy action whose repository input names another repository is left to that repository's rules), or a semantic-release run while `release.config.js` lists `@semantic-release/git`. It reads a command where the shell runs it, in a substitution, an `sh -c` string, an `eval` or text piped or fed to a shell; follows the checked-out branch of each checkout (the root's, and one `actions/checkout` makes at a `path`) for each git command in the checkout its directory is in: the step's `working-directory`, then the script's `cd` and `pushd` (a subshell, a substitution, a command of a pipeline and a background job, the whole and-or list an `&` ends, change directory for themselves alone, and a function's body where the function is called; past a pipeline whose last command changes directory, which `shopt -s lastpipe` runs in the script's own shell, the directory is one it cannot tell), `env -C` (the last one an `env` is given; a script piped or fed to a shell runs where that shell runs, in the directory its `env -C` names, with its `GIT_DIR`, after the substitutions in an unquoted heredoc's body, which run where the heredoc's command runs, before it), `git -C`, `--git-dir` and `GIT_DIR` (set before the command, or in the `env:` of its step, job or workflow; `env -i` and `env -u` remove it, and through `sudo` without `-E` the checkout is one it cannot tell), or a push action's directory input; a command whose directory it cannot tell is read in every checkout. It follows the branch through `&&`, `||`, `if`, `case`, loops and steps with an `if:` condition (any of which may not run) and into the local composite actions a job calls (`uses: ./<path>`, with the inputs its `with:` gives, else their defaults; an input in a step's `if:` is a string, so an input of `false` there still runs the step); reads `git push` options as git does (`--dry-run --no-dry-run` pushes, `--mir` is `--mirror`); and reads `git config` as git does: in the checkout it runs in, with `--global` and `--system` beneath every checkout's own, and `--unset` removing only the value its pattern matches in the key it names (`remote.origin.push` and `remote.backup.push` are two keys). A script a shell reads from a file, a variable or a download, a git setting made through `GIT_CONFIG_*` variables or a config file, a `GIT_DIR` a script sets, exports or unsets, a checkout `git clone` or `git worktree add` makes, and a push made by another action, are not read. It reads the YAML with [mikefarah's yq](https://github.com/mikefarah/yq) v4, which GitHub's Ubuntu runners carry; run it elsewhere with `yq` on the path, or `YQ` naming it: `node .github/scripts/check-workflow-pushes.mjs`.

## Required secrets

- `NPM_TOKEN`: an npm token with publish access to `@framers/sql-storage-adapter`. The release uses it only when the exchange fails; the Deprecate a version workflow uses it on every run, since the exchange covers `npm publish` alone ([npm's trusted publishers page](https://docs.npmjs.com/trusted-publishers)).

`GITHUB_TOKEN`, which GitHub Actions provides, creates the tag and the release.
