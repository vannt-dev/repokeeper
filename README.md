# repokeeper

Keep every repository on one maintained standard: Conventional Commits, git hooks, community health
files, editor and gitignore settings, Dependabot, CI and releases — applied once and kept in sync as
the standard evolves.

> Status: early development. Supported stacks: Node.js (including NestJS), Python, Dart and
> Flutter, shell and PowerShell scripts, Java (Maven and Gradle), Kotlin, .NET, Go, Rust, PHP and
> Ruby, each with CI and releases, plus GitHub settings through `repokeeper github apply`. GitLab is
> supported for Node.js projects. See the
> [design](docs/superpowers/specs/2026-09-25-repokeeper-design.md).

## Usage

repokeeper is not on npm yet. Until the first release, build it from source and link the command:

```bash
git clone https://github.com/vannt-dev/repokeeper.git
cd repokeeper && npm ci && npm run build && npm link
```

Then, in the repository you want to standardise (commit your work first — repokeeper refuses to
write over uncommitted or untracked files unless you pass `--force`):

```bash
repokeeper init     # detect the stack, write .repokeeper.yml, apply the standard
repokeeper check    # report drift; exits 1 when the repository has drifted
repokeeper update   # move to the latest standard without overwriting your edits
```

`init` never overwrites a file you already have: it reports it as unmanaged. Pass
`--adopt <path>` to let repokeeper manage it, or list it under `owned` in `.repokeeper.yml` to keep it
yours. `owned` also takes a single key of a shared file, such as `.github/workflows/ci.yml#on` or
`package.json#devDependencies.lefthook`; repokeeper then leaves that key, and everything under it,
alone. Every write command accepts `--dry-run`.

`init` reads the default branch from `origin/HEAD` and records it as `github.default_branch` when it
isn't `main`. The release manifest starts from the latest `vX.Y.Z` tag when the stack has no version
of its own.

After writing, repokeeper prints what is left to do (installing the git hooks, and
`git add --renormalize .` when tracked files are stored with CRLF). `init`, `update` and `check` also
point out what they can't fix: `.gitattributes` lines above the repokeeper block that the block
overrides, and pull request workflows of your own that run the same tests as the repokeeper ci job.

Stack notes: Python runs `mypy` on the files its config names (`files = …`), or on the whole tree
otherwise. The dotnet stack needs SDK-style projects; `init` stops with the names of .NET Framework
projects, which the dotnet CLI can't build.

Requires Node.js 22.12 or newer.

## CI and releases

`ci.yml` and `release.yml` call reusable workflows from this repository (`stack-node.yml`,
`commitlint.yml`, `release-please.yml`) at the moving major tag, so fixes reach every repository
without a pull request. repokeeper owns the `name`, `on`, `permissions` and `concurrency` keys and
the jobs it adds; jobs you add yourself are left alone, and so is the formatting of the rest of the
file. A new push to a pull request cancels that pull request's earlier `ci` run; runs on the default
branch always finish.

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

Set `modules.drift: true` to add a `repokeeper` job to `ci.yml` that runs `repokeeper check` with
the version that wrote the standard, so a pull request that edits a managed file fails until the edit
is resolved.

## GitHub settings

`repokeeper github apply` brings the repository's settings in line with the `github:` section of
`.repokeeper.yml`. Only the keys you write are managed; anything left out stays as it is.

```yaml
github:
  description: Keeps repositories on one standard
  topics: [cli, conventional-commits]
  merge: { squash: true, merge_commit: false, rebase: false, delete_branch_on_merge: true }
  security: { dependabot_alerts: true, dependabot_security_updates: true }
  protect:                  # a ruleset named "repokeeper" on the default branch; false removes it
    require_pull_request: true
    required_approvals: 0
    required_checks: ["commits / commitlint"]   # check names exactly as pull requests show them
    allow_force_push: false
```

It prints every change first and applies them with `--yes`, or after you confirm in a terminal;
`--dry-run` only prints. The token comes from `GITHUB_TOKEN` or `gh auth token` and needs admin
access to the repository. Legacy branch protection, visibility, secrets and collaborators are never
touched.

## GitLab

`repokeeper init` selects GitLab when the `origin` remote's host contains `gitlab`; pass
`--platform gitlab` otherwise (a self-hosted instance under another name, or no remote yet). Only
the node stack is supported on GitLab for now.

What differs from GitHub:

| | GitHub | GitLab |
| --- | --- | --- |
| Templates, CODEOWNERS | `.github/` | `.gitlab/` |
| CI | caller workflows of reusable workflows | every job generated into `.gitlab-ci.yml` |
| Dependency updates | Dependabot | Renovate (`renovate.json`) |
| Releases | release-please, through a release pull request | semantic-release, on every push to the default branch |

Jobs you add to `.gitlab-ci.yml` are kept; repokeeper manages only its own top-level keys
(`workflow`, `node`, `commits`, `repokeeper`, `renovate`, `release`). `stack_options.node.os` has
no effect: GitLab jobs run on Linux.

Two things to know when you add jobs of your own:

- The managed `workflow` runs pipelines for merge requests, the default branch, schedules and
  tags. repokeeper's own jobs skip tags, so a tag pipeline holds only your jobs (publishing, for
  example). A job meant for other branches never starts. To write the `workflow` rules yourself,
  list the key under `owned` in `.repokeeper.yml`: `owned: [".gitlab-ci.yml#workflow"]`.
- repokeeper's jobs use GitLab's default stages `test` and `deploy`. If you declare `stages`,
  include both; repokeeper warns when one is missing.

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

`repokeeper github apply` has no GitLab counterpart yet.

## Pilots

Each stack is tried on a real or demo repository before a release. The demo repositories carry the
[`repokeeper-demo`](https://github.com/topics/repokeeper-demo) topic:
[dart](https://github.com/vannt-dev/repokeeper-demo-dart),
[dotnet](https://github.com/vannt-dev/repokeeper-demo-dotnet),
[go](https://github.com/vannt-dev/repokeeper-demo-go),
[kotlin](https://github.com/vannt-dev/repokeeper-demo-kotlin),
[php](https://github.com/vannt-dev/repokeeper-demo-php),
[ruby](https://github.com/vannt-dev/repokeeper-demo-ruby) and
[rust](https://github.com/vannt-dev/repokeeper-demo-rust).

## License

MIT
