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

## Drift check

Set `modules.drift: true` to add a `repokeeper` job to `ci.yml` that runs `repokeeper check` with
the version that wrote the standard, so a pull request that edits a managed file fails until the edit
is resolved.

---

Back to the [README](../README.md).
