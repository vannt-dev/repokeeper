# GitLab

`repokeeper init` selects GitLab when the `origin` remote's host contains `gitlab`; pass
`--platform gitlab` otherwise (a self-hosted instance under another name, or no remote yet).

What differs from GitHub:

| | GitHub | GitLab |
| --- | --- | --- |
| Templates, CODEOWNERS | `.github/` | `.gitlab/` |
| CI | caller workflows of reusable workflows | every job generated into `.gitlab-ci.yml` |
| Dependency updates | Dependabot | Renovate (`renovate.json`) |
| Releases | release-please, through a release pull request | semantic-release, on every push to the default branch |

Jobs you add to `.gitlab-ci.yml` are kept; repokeeper manages only its own top-level keys
(`workflow`, the jobs of the stacks below, `commits`, `repokeeper`, `renovate`, `release`).

## Stacks

Every stack has its CI job on GitLab. A job runs the commands the stack's GitHub workflow runs, in a
container image instead of on a runner that a setup action prepares:

| Stack | Job | Image | Notes |
| --- | --- | --- | --- |
| node | `node` | `node:<version>` | npm cache; corepack for pnpm and yarn |
| python | `python` | `python:<version>` | `pip install uv` first when the project has a `uv.lock` |
| go | `go` | `golang:<version>` | `stable` is the image's `latest` tag |
| rust | `rust` | `rust:latest` | the toolchain named in `versions` is installed with rustfmt and clippy |
| ruby | `ruby` | `ruby:<version>` | |
| php | `php` | `php:<version>-cli` | Composer, git and unzip are installed first; the image has PHP's default extensions only |
| dart | `dart` | `dart:<version>`, or `ghcr.io/cirruslabs/flutter:<version>` for Flutter | |
| java, kotlin | `java`, `kotlin` | `maven:3-eclipse-temurin-<version>`, `gradle:jdk<version>`, or `eclipse-temurin:<version>-jdk` when the project has its own `gradlew` | |
| dotnet | `dotnet` | `mcr.microsoft.com/dotnet/sdk:<newest version>` | one job; the other SDKs in `versions` are installed beside it |
| script | `shell`, `powershell`, `script-test` | `koalaman/shellcheck-alpine`, `mcr.microsoft.com/dotnet/sdk` (for its PowerShell) | ShellCheck and shfmt; PSScriptAnalyzer; your `test` command |

What to know:

- **Linux only.** `stack_options.<stack>.os` has no effect, and repokeeper says so. The script
  stack's test command runs once, on Linux, where on GitHub it also runs on Windows.
- **No dependency caches** except npm's. A cache has to live inside the project folder, where
  formatters and linters would read it as the project's own code.
- **Stacks at the root only.** A stack in a folder of its own (`stack_options.<stack>.directory`)
  is for GitHub.
- **Releases write the version themselves.** semantic-release knows `package.json` and nothing
  else, so for the other stacks the release runs `repokeeper bump <version>`, which writes the
  version into the stack's file: `pyproject.toml` (or `setup.cfg`, `setup.py`), `pubspec.yaml`,
  `pom.xml`, `Cargo.toml` and `Cargo.lock`, `composer.json` when it has a `version`,
  `lib/<name>/version.rb` and `Gemfile.lock`, `Directory.Build.props`, and `gradle.properties`
  between the markers repokeeper puts around its version line. Those files and `CHANGELOG.md` are
  what the release commits. A stack without a version file (Go, scripts, a Gradle build without
  `version=`) is released by its changelog and tag alone. Try it with
  `repokeeper bump 1.2.3 --dry-run`.

## Jobs of your own

Two things to know when you add jobs of your own:

- The managed `workflow` runs pipelines for merge requests, the default branch, schedules and
  tags. repokeeper's own jobs skip tags, so a tag pipeline holds only your jobs (publishing, for
  example). A job meant for other branches never starts. To write the `workflow` rules yourself,
  list the key under `owned` in `.repokeeper.yml`: `owned: [".gitlab-ci.yml#workflow"]`.
- repokeeper's jobs use GitLab's default stages `test` and `deploy`. If you declare `stages`,
  include both; repokeeper warns when one is missing.

## The two jobs that need a token

Two jobs stay inactive until you set them up in the project's CI/CD settings:

- **`release`** needs a CI/CD variable `GITLAB_TOKEN`: a project access token with the `api` and
  `write_repository` scopes and a role that may push to the default branch. Every push to the
  default branch with a `feat`, `fix` or breaking change then releases at once: version bump,
  `CHANGELOG.md`, tag and GitLab release. There is no release merge request. A repository without
  a `vX.Y.Z` tag starts at `1.0.0`; tag the current version first to continue from it. A variable
  marked Protected is only visible on protected branches, so protect the default branch or leave
  the variable unprotected; otherwise the job silently stays away.
- **`renovate`** needs a CI/CD variable `RENOVATE_TOKEN` (same scopes) and a pipeline schedule,
  for example weekly. The schedule alone decides how often Renovate runs.

## Project settings: `repokeeper gitlab apply`

Settings of the project itself are kept under `gitlab:` in `.repokeeper.yml`. Only the keys you
write are managed; anything left out stays as it is on GitLab.

```yaml
gitlab:
  description: Keeps the build tools in one place
  topics: [cli, tooling]
  merge:
    method: ff                      # merge | rebase_merge | ff
    squash: default_on              # never | always | default_on | default_off
    delete_source_branch: true
    pipeline_must_succeed: true
    discussions_must_be_resolved: true
  protect:                          # the default branch; false removes the protection
    push: maintainers               # none | developers | maintainers
    merge: developers
    allow_force_push: false
  renovate_schedule: "0 5 * * 1"    # cron, in UTC; false removes the schedule
```

```bash
repokeeper gitlab apply --dry-run   # show what differs, change nothing
repokeeper gitlab apply             # show it, ask, then apply; --yes skips the question
```

It needs a token with the `api` scope and the Maintainer role on the project: `GITLAB_TOKEN` in the
environment, or the one the GitLab CLI holds after `glab auth login`. The host is the one of the
`origin` remote, so a self-hosted instance works the same way.

What to know:

- **`protect`** covers the default branch only. Keys you leave out take GitLab's own defaults:
  Maintainers push, Maintainers merge, no force push. A protection that differs is removed and
  created again, so the branch is unprotected for a moment while `apply` runs. The token of the
  `release` job has to be allowed to push: with `push: maintainers`, give it the Maintainer role.
- **`renovate_schedule`** creates one pipeline schedule, described as `repokeeper: renovate`, on the
  default branch. Schedules under any other name are never touched. This is the schedule the
  `renovate` job above waits for.
- **CI/CD variables are never written.** `apply` only tells you when `GITLAB_TOKEN` (for a
  repository with releases) or `RENOVATE_TOKEN` (with dependency updates) is not set in the project.
  A variable inherited from a group is not visible to this check, so the note can be wrong there.
- **No approval rules.** The number of approvals a merge request needs is a paid-tier setting on
  GitLab, and repokeeper does not manage it.

---

Back to the [README](../README.md).
