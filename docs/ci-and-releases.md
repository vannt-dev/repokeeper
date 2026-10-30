# CI and releases

`ci.yml` and `release.yml` call reusable workflows from this repository (`stack-node.yml`,
`commitlint.yml`, `release-please.yml`) at the moving major tag, so fixes reach every repository
without a pull request. repokeeper owns the `name`, `on`, `permissions` and `concurrency` keys and
the jobs it adds; jobs you add yourself are left alone, and so is the formatting of the rest of the
file. A new push to a pull request cancels that pull request's earlier `ci` run; runs on the default
branch always finish.

## Pinning, mirroring and local copies

Following the moving major tag means a change to a reusable workflow reaches your CI the day it is
released. If you would rather decide when, set where the workflows are called from in
`.repokeeper.yml` and run `repokeeper update`:

```yaml
github:
  workflows:
    ref: exact                         # the release of the repokeeper that wrote the file
    # ref: 0123456789abcdef…           # or a commit SHA, or a tag such as v0.5.0
    # source: your-org/ci-workflows    # a copy in a repository of your organisation
    # source: local                    # copies in this repository
```

- **`ref: exact`** calls `…@v0.5.0` instead of `…@v0`. Updating repokeeper and running
  `repokeeper update` moves it, in a commit you review. A tag can still be moved by whoever controls
  the repository it is in; a commit SHA cannot, so write one as `ref` when that matters, and change
  it yourself when you want a newer version.
- With a `ref`, the generated `dependabot.yml` tells Dependabot to leave these workflow references
  alone: one owner moves them, not two.
- **`source: your-org/ci-workflows`** calls a copy you host. `repokeeper eject --to <folder>` writes
  every reusable workflow into `<folder>/.github/workflows/` of a clone of that repository; commit
  them there and allow the organisation's repositories to use its workflows. `ref` defaults to `main`.
- **`source: local`**, or simply `repokeeper eject`, gives the repository its own copies of the
  workflows it calls and points `ci.yml` and `release.yml` at them. From then on nothing in your CI
  refers to this repository. The copies are yours: repokeeper writes them once and never changes
  them, so updates are yours to take, by comparing with a newer `repokeeper eject --to`.

## Pull requests that change only documentation

A pull request that only fixes a typo in the README still waits for every stack job. To skip
them, list the paths that cannot change what the jobs test:

```yaml
github:
  ci:
    skip_when_only:
      - "*.md"          # Markdown at the root only, as in GitHub's path filters
      - "docs/**"
```

`ci.yml` then gets a `changes` job that asks the API for the pull request's files. When every
file matches, the stack jobs are skipped; GitHub counts a skipped job as passed. The commit
message check and the drift check still run on every pull request, and pushes to the default
branch always run everything. If the `changes` job cannot tell (the API call fails, say), the stack
jobs run.

- Leave out any file your tests read. A test that checks the README's examples, for instance,
  needs `README.md` kept out of the list.
- A skipped job that calls a reusable workflow reports only its own name, never the checks inside
  it (`node / test (22)`), so a required check on a stack job would wait forever. repokeeper refuses
  such a `github.protect.required_checks` entry while `skip_when_only` is set.
- GitHub only: GitLab's `rules:changes` can say "any of these changed", not "only these".

## Shell and PowerShell scripts

The script stack runs ShellCheck and `shfmt -d` on `*.sh` (format with `shfmt -w` before pushing)
and PSScriptAnalyzer on `*.ps1`, which fails on errors and warnings (not on information-level rules). To
choose the rules yourself, add a `PSScriptAnalyzerSettings.psd1` at the repository root; the job then
uses it instead of its own filter, so keep `Severity` in it unless you want information-level rules too:

```powershell
@{
    Severity     = @('Error', 'Warning')
    # installers print for the person running them
    ExcludeRules = @('PSAvoidUsingWriteHost')
}
```

## Releases

`release.yml` runs [release-please](https://github.com/googleapis/release-please): it keeps a release
pull request open, and merging it tags the release and updates `CHANGELOG.md`. Two settings make this
work:

- In the repository settings, under Actions → General, allow GitHub Actions to create and approve
  pull requests.
- Optionally add a `RELEASE_PLEASE_TOKEN` secret (a fine-grained token with contents, pull requests
  and issues write access). Without it the release pull request is opened with `GITHUB_TOKEN`, and
  GitHub holds its `pull_request` runs until someone approves them; the `release-pr-ci` job approves
  them, so the pull request gets its checks and required checks in a ruleset can pass.

A repository with no release yet (manifest at `0.0.0`) gets `initial-version: 0.1.0`, so its first
release is 0.1.0 rather than release-please's default 1.0.0.

## Dockerfiles

The docker stack is detected from a `Dockerfile` or `Containerfile` (also with a suffix, as in
`Dockerfile.dev`, or named `<name>.Dockerfile`). Unlike scripts, it is kept beside another stack: a
Node.js project with a Dockerfile gets both jobs. Its job runs [hadolint](https://github.com/hadolint/hadolint)
on every Dockerfile at the stack's root, and Dependabot keeps the base images up to date (and the
images of a compose file, when there is one).

hadolint fails the job on errors and warnings; information-level rules are printed and do not fail
it. To choose the rules yourself, add a `.hadolint.yaml` beside the Dockerfiles. The job then uses it
as it is, so set `failure-threshold` in it unless you want every rule to fail the job:

```yaml
failure-threshold: warning
ignored:
  - DL3018   # pin versions in apk add
```

Two options, under `stack_options.docker`:

```yaml
stack_options:
  docker:
    files: [Dockerfile, docker/worker.Dockerfile]   # instead of the ones found at the root
    build: true                                     # also `docker build` each one; nothing is pushed
```

The build is off unless you ask for it: a build may need a context, arguments or secrets a lint does
not. When it is on, each file is built with the stack's folder as its context. On GitLab only the lint
is written; building an image there needs a runner set up for it, and repokeeper says so.

## Drift check

Set `modules.drift: true` to add a `repokeeper` job to `ci.yml` that runs `repokeeper check` with
the version that wrote the standard, so a pull request that edits a managed file fails until the edit
is resolved.

One edit is not drift: a step of a managed job that uses the same action at another commit or tag, as
a Dependabot pull request leaves it. `check` passes, and `update` keeps the newer version. Any other
change to the job still counts, and so does the ref a job calls a reusable workflow at
(`uses: …/.github/workflows/…@v0`), which repokeeper pins on purpose.

## Update pull requests

Set `modules.autoupdate: true` and repokeeper writes `.github/workflows/repokeeper-autoupdate.yml`: every
Monday, and whenever you start it by hand, it runs `repokeeper update` with the newest repokeeper. When
that changes anything, it pushes the branch `repokeeper/update` and opens a pull request named
`chore(repokeeper): update standard to X.Y.Z`; a later run moves the same branch and edits the same pull
request. When nothing changes, the run ends with a notice and no pull request.

What the pull request holds is what `repokeeper update` would write on your machine:

- Files you edited by hand, and the ones listed under `owned`, are left alone. The body of the pull request
  carries the update's own report, so the files it kept are named there, and the run shows a warning.
- When the update changes a `package.json` that has a `package-lock.json` beside it, the lockfile is brought
  in step, so `npm ci` still installs. With pnpm, Yarn or Bun the body says that the lockfile is still to
  be updated on the branch.

The job needs a token:

- **A token of your own, as the secret `REPOKEEPER_TOKEN`**, with read and write access to contents, pull
  requests and workflows. This is what most repositories need, because an update usually changes a file
  under `.github/workflows/`, which `GITHUB_TOKEN` may not push. A pull request opened with your own token
  also starts CI by itself.
- **Without the secret**, `GITHUB_TOKEN` is used. It can propose an update that touches no workflow file;
  for one that does, the run fails and says so. GitHub holds the `pull_request` runs of a pull request
  that `GITHUB_TOKEN` opened, so the `update-pr-ci` job approves them, as `release-pr-ci` does for releases.

The switch is off unless you ask for it, and it is for GitHub: on GitLab it writes nothing, and
`repokeeper update` run by hand does the same work. It needs repokeeper 0.9.0 or newer.

## Code scanning

Set `modules.security: true` and repokeeper writes `.github/workflows/security.yml`. Its `codeql` job
calls the reusable workflow `codeql.yml`, which runs [CodeQL](https://codeql.github.com/) and reports
what it finds as code scanning alerts, on the pull request and under the repository's Security tab.
It runs on every pull request, on every push to the default branch, and once a week, because new
queries find things in code that has not changed.

What is analyzed follows from the stacks in `.repokeeper.yml`:

| Stack | CodeQL language | Build |
| --- | --- | --- |
| `node` | `javascript-typescript` | none |
| `python` | `python` | none |
| `java` | `java-kotlin` | none |
| `kotlin` | `java-kotlin` | CodeQL's own (`autobuild`) |
| `dotnet` | `csharp` | none |
| `go` | `go` | CodeQL's own (`autobuild`) |
| `ruby` | `ruby` | none |
| `rust` | `rust` | none |
| `dart`, `php`, `script`, `docker` | not analyzed: CodeQL does not know them | |

The workflow files themselves are always analyzed too (`actions`), so a repository with only Dart or
PHP still gets that. Most languages are read from source. Go and Kotlin are not: CodeQL has to watch a
build, and works out how to run one. When that build needs something it cannot guess, list
`.github/workflows/security.yml#jobs.codeql` under `owned` and call CodeQL with your own build steps.

Three things to know:

- **Public and private repositories.** Code scanning is free on a public repository. A private one
  needs GitHub Code Security; without it the analysis runs and then fails when it uploads its results.
  This is why no preset switches the module on.
- **Default setup.** If CodeQL's default setup is on in the repository's settings, GitHub refuses the
  results of a workflow. Use one or the other.
- **GitLab.** The switch writes nothing there. GitLab has its own SAST and Secret Detection
  templates, which you include in `.gitlab-ci.yml` yourself.

It needs repokeeper 0.9.0 or newer.

## Cache cleanup

Actions caches share a 10 GB limit per repository. Over it, GitHub evicts caches on its own, including
ones still in use. Set `modules.cache_cleanup: true` and repokeeper writes
`.github/workflows/cache-cleanup.yml`, which deletes the caches nothing will read again:

- **When a pull request closes** (merged or not), the caches it saved. Only that pull request could read
  them. The workflow runs on `pull_request_target`, so a pull request from a fork gets a token that can
  delete them too. Nothing is checked out and no code from the pull request runs: the job reads only the
  pull request number.
- **Once a week** (Sunday 03:23 UTC, or when you start it by hand), a sweep:
  - deletes the caches of every closed pull request, including ones that closed before the workflow
    existed;
  - on each branch, groups the caches by kind (the key without its trailing hash) and deletes every copy
    left unused for more than a day longer than the newest one. These are older copies that a newer run
    saved again under a new key, after a lockfile changed for example. GitHub would drop them only after
    7 days without use.

The job uses only `gh` and `jq`, which the runner already has, with `GITHUB_TOKEN` and
`actions: write`. It lists each deleted cache in the log and writes the count and the size to the run
summary.

The switch is off unless you ask for it, and no preset turns it on: it deletes things, so you decide.
It is for GitHub only. On GitLab it writes nothing, because GitLab has no Actions caches: a runner keeps
its own cache and expires it there. It needs repokeeper 0.11.0 or newer.

## Dependabot auto-merge

Set `modules.automerge: true` and repokeeper writes `.github/workflows/automerge.yml`. On each of
Dependabot's pull requests, its job calls the reusable workflow `dependabot-automerge.yml`. That
workflow reads what the update is with
[`dependabot/fetch-metadata`](https://github.com/dependabot/fetch-metadata) and, for a **patch or
minor** update, turns on GitHub's auto-merge for the pull request. A **major** update is never
auto-merged. A grouped pull request counts as its biggest update, so one major in the group leaves the
whole group for you. Pull requests from anyone else are not touched.

Auto-merge does not merge right away. GitHub merges the pull request only once everything the default
branch requires has passed: the required checks, and the required reviews if the branch asks for any.
A failing check keeps the pull request open. Because of this, the workflow turns auto-merge on only
when the default branch requires something: a ruleset with a required check or with at least one
required approval, or classic branch protection with required status checks. When nothing is required,
auto-merge would merge before CI has run, so the run leaves it off and shows a warning. Set
`github.protect.required_checks` (see [GitHub settings](github-settings.md)) to the checks that must
pass, for example `["node / test (ubuntu-latest, 22)", "commits / commitlint"]`.

Two things to set up, once:

- **Allow auto-merge in the repository.** `repokeeper github apply` turns on the repository setting
  (`allow_auto_merge`) whenever the module is on. You can also write it yourself as
  `github.merge.auto_merge: true`. Setting it to `false` while the module is on is refused, because
  the workflow would fail on every pull request.
- **Optional: a token, as the Dependabot secret `AUTOMERGE_TOKEN`.** With the default `GITHUB_TOKEN`,
  the push that the merge makes to the default branch starts no workflow: the `ci` run on the default
  branch and the `release` workflow wait for the next push. A fine-grained token with read and write
  access to contents and pull requests, saved under *Settings → Secrets and variables → Dependabot*
  (not under Actions: a run that Dependabot starts sees only Dependabot secrets), makes the merge
  start them as usual.

The merge method is the first one `github.merge` allows, in this order: squash, merge commit, rebase.

**Presets.** No preset turns the module on. If you turn it on with the `strict` preset, its ruleset
still asks for one approving review on every pull request. Auto-merge then waits for a person to
approve, because the workflow never approves anything itself. Under `strict`, the module saves you the
merge click and nothing more.

On GitLab the switch writes nothing: Renovate opens the updates there and has its own `automerge`
setting. It needs repokeeper 0.11.0 or newer.

## Publishing to npm and PyPI

Set `modules.publish: true` and repokeeper adds a `publish` job to `.github/workflows/release.yml`. When
the release job has created a release (the moment release-please's pull request is merged), the job
checks out the release and publishes it:

| Released stack | Registry | What the job runs |
| --- | --- | --- |
| `node` | npm | Node.js 24, the stack's install command (`npm ci`, `pnpm install`, ...), then `npm publish --access public` |
| `python` | PyPI | `python -m build`, then [`pypa/gh-action-pypi-publish`](https://github.com/pypa/gh-action-pypi-publish) |

It uses **trusted publishing**: the job has `id-token: write`, and the registry accepts the short-lived
OIDC token that GitHub gives the run. No npm or PyPI token is stored anywhere. On npm, a package
published this way from a public repository gets a
[provenance statement](https://docs.npmjs.com/generating-provenance-statements) by itself. That is why
the job does not pass `--provenance`: npm makes no provenance for a private repository and would refuse
the flag there.

The job is part of `release.yml` itself, not a reusable workflow. PyPI does not accept a reusable
workflow as a trusted publisher, and npm checks the name of the calling workflow. So on both registries
the trusted publisher names `release.yml`.

**Set up once, before the first release** (until then the job fails):

- **npm:** on npmjs.com, open the package → *Settings* → *Trusted publishing* → *GitHub Actions*, and
  enter the owner, the repository and the workflow filename `release.yml`. Leave the environment empty.
  Under the allowed actions, allow `npm publish`. A package that is not on npm yet has to be published
  once by hand first, because the setting belongs to an existing package. The `repository.url` in
  `package.json` has to point at this repository too.
- **PyPI:** on pypi.org, under *Your projects* → *Publishing* (or, for a new project, *Add a pending
  publisher*), add a GitHub publisher with the owner, the repository and the workflow `release.yml`,
  and leave the environment empty.

**The trap.** Every field is matched exactly and is case-sensitive, and the registry does not check the
entry when you save it. When the owner, the repository or the workflow filename differs in any way (for
example `release.yaml`, `publish.yml`, or an owner spelled with different capitals), the token is
refused. npm then answers the publish with **404 Not Found** or **403 Forbidden**, which reads like a
missing package or a missing permission rather than a mismatch. If the first publish fails that way,
compare the entry with the repository's URL and `release.yml` letter by letter. PyPI states the reason
more plainly (`invalid-publisher`), but the fix is the same.

What else to know:

- The job builds what the package itself builds: npm runs the package's `prepack` and `prepublishOnly`
  scripts during `npm publish`, so put the build there. For Python, `python -m build` uses the build
  backend in `pyproject.toml`.
- It publishes the stack that is released, which is the first stack with a release type of its own (see
  [Releases](#releases)). When that stack is neither `node` nor `python`, the switch writes nothing, and
  `init`, `update` and `check` say so. The same happens when `modules.release` is off.
- **Folders are not supported.** release-please names the outputs of a package in a folder after the
  folder, and the release workflow does not pass those on. A stack under
  `stack_options.<stack>.directory` is therefore not published, and the switch says so.
- The actions the job uses are pinned to commits, the same ones repokeeper's own workflows use.
  Dependabot keeps them up to date like any other action: a newer commit or tag of the same action is
  not drift (see [Drift check](#drift-check)). While the job is still as repokeeper wrote it,
  `repokeeper update` moves the pins itself.
- No preset turns the module on: not every package is meant to be public, and the registry has to be
  set up first.
- A `publish` job you wrote yourself, as repokeeper's own `release.yml` has, is reported as unmanaged.
  Adopt it with `--adopt`, or keep it by listing `.github/workflows/release.yml#jobs.publish` under
  `owned`.
- On GitLab the switch writes nothing: releases there are semantic-release's.

It needs repokeeper 0.11.0 or newer.

## Workflow lint

Set `modules.workflow_lint: true` and repokeeper writes `.github/workflows/workflow-lint.yml`. Its `lint`
job calls the reusable workflow `workflow-lint.yml`, which checks the repository's GitHub Actions
workflows with two tools:

- [actionlint](https://github.com/rhysd/actionlint) finds mistakes: an expression that does not parse,
  an input the called workflow does not have, a step output that does not exist, and, through
  shellcheck, problems in `run:` scripts.
- [zizmor](https://docs.zizmor.sh/) finds security problems: actions not pinned to a commit, template
  injection (`${{ }}` of untrusted text inside a script), credentials left on disk by
  `actions/checkout`, permissions wider than the job needs, risky triggers. It also asks GitHub about
  the actions in use, for versions with a known vulnerability.

Findings appear as annotations on the pull request; the check fails on any of severity `low` or above.
Nothing is uploaded, so the module works on a private repository without GitHub Code Security. The
workflow runs on pull requests and pushes to the default branch that change `.github/` or an
`action.yml`, and once a week, because new advisories come out for actions already in use. Both tools
are pinned: actionlint to a release whose checksum the job verifies, zizmor through
`zizmorcore/zizmor-action` pinned to a commit and a set zizmor version.

zizmor reads its settings from `.github/zizmor.yml`, and repokeeper writes three of them, each for a
file it writes itself:

| Setting | Why |
| --- | --- |
| `unpinned-uses` policy `vannt-dev/repokeeper/*: ref-pin` | The callers follow the `v0` tag of the workflow repository, which a repokeeper release moves on purpose. A mirror (`github.workflows.source`) gets its own name here; local copies need nothing. |
| `dangerous-triggers` ignores `cache-cleanup.yml` | Only with `modules.cache_cleanup`. It runs on `pull_request_target` but checks nothing out (see [Cache cleanup](#cache-cleanup)). |
| `dependabot-cooldown` ignores `dependabot.yml` | Only with `modules.deps`. repokeeper writes the whole file, and a cooldown would hold back every version update, which is the repository's choice. Security updates are not held back either way. |

Add rules of your own next to these: repokeeper manages only its own keys. Every file repokeeper writes
with every module on passes both tools: `fixtures/workflow-lint` in repokeeper's own repository holds
those files, and its CI runs the workflow lint on them.

What to know before switching it on:

- **Workflows of your own** are checked as strictly. zizmor 1.31 wants every action, `actions/checkout`
  included, pinned to a commit (`actions/checkout@<sha> # v7.0.1`); `zizmor --fix` and
  [pinact](https://github.com/suzuki-shunsuke/pinact) can pin them for you, and Dependabot then keeps the
  commits up to date. Fix the findings, or ignore one with a reason in `.github/zizmor.yml` or a
  `# zizmor: ignore[<audit>]` comment, before you make the check required.
- **Local copies.** With `github.workflows.source: local`, the reusable workflows are files of the
  repository, and zizmor checks them like any other.
- No preset turns the module on, since it fails until those findings are fixed.
- On GitLab the switch writes nothing: both tools read GitHub Actions workflows only.

It needs repokeeper 0.17.0 or newer.

---

Back to the [README](../README.md).
