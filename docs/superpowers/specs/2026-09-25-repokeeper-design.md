# repokeeper — design

Date: 2026-09-25 · Status: approved in conversation, awaiting written-spec review

## 1. Purpose

repokeeper applies one maintained engineering standard to a repository — commit conventions, git
hooks, CI, releases, dependency updates, community health files and hosting settings — and keeps
the repository on that standard over time.

Audience, in order:

1. The author's own repositories (about fifteen, across TypeScript/Node, Python, Dart/Flutter and
   shell/PowerShell), which today each organise CI, hooks and releases differently.
2. Anyone who installs it from npm: repokeeper is an open-source product.
3. Later, a shared standard other teams can adopt and extend.

### Success criteria for the first release

- Applied to at least four real repositories covering four stacks, with their CI still green.
- `repokeeper check` reports nothing immediately after `repokeeper init`.
- `repokeeper check` reports drift when a managed file is edited, deleted or older than the current
  standard.
- `repokeeper update` upgrades unmodified files and never overwrites a file the user changed.

### Decisions taken

| Topic | Decision |
| --- | --- |
| Lifecycle | Long-lived sync: `init`, `check`, `update`, plus a per-repo config file |
| Implementation | TypeScript CLI on npm, plus reusable GitHub Actions workflows hosted in this repo |
| Package name | `repokeeper` on npm (renamed from repokit: unscoped `repokit` is blocked by npm's similar-name rule because `repo-kit` exists); the command is `repokeeper` |
| Stacks | Core is stack-agnostic; stack packs add language tooling. v1 ships node (including NestJS), python, dart, script, java (Maven/Gradle, Spring Boot) and dotnet (ASP.NET Core) |
| Platforms | Platform adapter layer from the start. v1 ships GitHub; GitLab is phase 2 |
| Hosting settings | Managed, but only through an explicit `repokeeper github apply` with a preview |
| Workflow | GitHub Flow, Conventional Commits, SemVer, release-please |

### Assumptions

- Only GitHub is supported until the GitLab adapter lands.
- repokeeper never silently overwrites content the user changed; conflicts are reported.

### Out of scope for v1

GitLab; monorepos with several independently released packages; a web UI or dashboard; opening
pull requests across many repositories at once.

## 2. Architecture

```
CLI (init · check · update · github apply)
        │
   Config ──▶ Planner ──▶ Sync engine ──▶ files in the repository
 (.repokeeper.yml)  │           (hash / block / JSON key)
                 ├── Core modules: editorconfig · commits · hooks · health · gitignore · deps · ci · release
                 ├── Stack packs: node · python · dart · script · java · dotnet
                 └── Platform adapter: github (v1) · gitlab (phase 2)
```

Units and their contracts:

- **Config** (`src/config/`): loads `.repokeeper.yml`, validates it against a JSON Schema shipped in
  the package, and returns a typed `RepokeeperConfig`. Errors name the key and line.
- **Stack pack** (`src/stacks/<id>.ts`): pure data describing a language — detection files, tool
  commands, staged-file commands, runtime setup, release type, gitignore template and Dependabot
  ecosystems. No platform-specific output.
- **Module** (`src/modules/<id>.ts`): given the config, the selected stack packs and the platform
  adapter, returns the desired outputs for its concern.
- **Platform adapter** (`src/platforms/<id>.ts`): renders platform-specific outputs — CI files,
  issue/PR templates, dependency-update config, release automation — and implements settings
  read/apply for its hosting API.
- **Planner** (`src/plan.ts`): a pure function from config to a list of desired outputs. It never
  touches the filesystem, so it is tested directly.
- **Sync engine** (`src/sync/`): compares desired outputs with the working tree and the lock file,
  and produces a change set; a separate writer applies it.
- **Lock file** (`.repokeeper/lock.json`): for every managed output, the path, strategy, template id,
  standard version and SHA-256 of the content repokeeper last wrote.

### Output strategies

| Strategy | Used for | Ownership |
| --- | --- | --- |
| `file` | `lefthook.yml`, CI caller workflow, `commitlint.config.mjs`, templates | Whole file |
| `block` | `.gitignore`, `.gitattributes` | Text between `repokeeper:start <id>` / `repokeeper:end <id>` markers, in the file's comment syntax |
| `json` | `package.json` `scripts` entries, `devDependencies` of tools repokeeper configures | Named keys only |
| `yaml` | Keys of workflows such as `ci.yml` | Named keys only; only their lines are rewritten, the rest of the file keeps its formatting |

Block edits preserve the file's existing line endings and every byte outside the block.

## 3. Configuration

`.repokeeper.yml` at the repository root:

```yaml
schema: 1
standard: 1.0.0          # standard version applied; written by init/update
platform: github
stacks: [node]           # one or more of: node, python, dart, script, java, dotnet
modules:
  editorconfig: true
  commits: true
  hooks: true
  ci: true
  release: true
  deps: true
  gitignore: true
  health:
    license: MIT         # SPDX id, or false to leave licensing alone (v1 bundles MIT)
    copyright: Van Nguyen   # LICENSE holder; init reads git config user.name
    contact: https://github.com/vannt-dev   # Code of Conduct contact; init derives it from the origin remote
    codeowners: ["@vannt-dev"]
owned: []                # paths, or path#key / path#block, the user manages; repokeeper neither writes nor checks them
stack_options:
  node: { versions: ["22", "24"] }
  python: { versions: ["3.11", "3.12", "3.13"] }
github:                  # default_branch also drives the workflow triggers and CONTRIBUTING; the rest is for `repokeeper github apply`
  default_branch: main   # init sets it from origin/HEAD when that isn't main
  protect:
    required_checks: [ci]
    require_pull_request: true
    allow_force_push: false
  merge: { squash: true, merge_commit: true, rebase: false, delete_branch_on_merge: true }
  security: { dependabot_alerts: true, dependabot_security_updates: true }
  topics: []
```

Every module defaults to `true`; `init` writes the file with detected stacks and defaults.

## 4. Core modules

| Module | Outputs | Standard |
| --- | --- | --- |
| editorconfig | `.editorconfig`, block in `.gitattributes` | UTF-8, LF, final newline, trimmed whitespace; `*.ps1`, `*.bat`, `*.cmd` keep CRLF; `* text=auto eol=lf`; C#, F#, VB and Python use 4-space indentation (`dotnet format` enforces `.editorconfig`) |
| commits | `commitlint.config.mjs` | Conventional Commits via `@commitlint/config-conventional`; header ≤ 100 characters |
| hooks | `lefthook.yml` | `commit-msg`: commitlint. `pre-commit`: stack-pack staged commands on staged files only. `pre-push`: stack-pack test command. Installed with `lefthook install` |
| health | `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), issue forms, PR template, `CODEOWNERS` | GitHub community health files |
| gitignore | block in `.gitignore` | Stack templates from github/gitignore, pinned per standard version |
| deps | `.github/dependabot.yml` | Weekly; minor and patch grouped per ecosystem; `github-actions` always included |
| ci | caller workflow `.github/workflows/ci.yml` | Calls the reusable workflows in section 6 |
| release | `release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/release.yml` | SemVer; changelog from Conventional Commits; release type from the stack pack (`node`, `python`, `dart`, `maven`, `simple`) |

Tool installation: node repositories get `lefthook`, `@commitlint/cli` and
`@commitlint/config-conventional` as `devDependencies` (`json` strategy). Other stacks run them
through `npx --yes` pinned to the versions of the current standard, so Node.js 22 or newer is
required on developer machines for every stack — the same requirement repokeeper itself has. CI never
depends on local hooks: the reusable workflows run the same checks.

Adoption rule: when `init` finds an existing file at a path a module wants to own, it does not
overwrite it. The file is listed as unmanaged, and `repokeeper init --adopt <path>` (or `--adopt-all`)
hands it to repokeeper, which then records its hash and treats later differences as drift.

## 5. Stack packs (v1)

```ts
export default defineStack({
  id: "python",
  detect: ["pyproject.toml", "requirements.txt", "setup.cfg"],
  tools: { format: "ruff format", lint: "ruff check", typecheck: "mypy .", test: "pytest" },
  staged: { "*.py": ["ruff format {staged_files}", "ruff check --fix {staged_files}"] },
  setup: { runtime: "python", versions: ["3.11", "3.12", "3.13"] },
  release: "python",
  gitignore: ["Python"],
  dependabot: ["pip"],
})
```

| Pack | Detect | Format / lint | Test | CI matrix |
| --- | --- | --- | --- | --- |
| node | `package.json` | Biome if configured, otherwise Prettier + ESLint | package manager `test` script; npm/pnpm/yarn from the lockfile | Node 22, 24 |
| python | `pyproject.toml`, `requirements.txt` | Ruff format + check, mypy when configured | pytest | 3.11 – 3.13 |
| dart | `pubspec.yaml` | `dart format`, `flutter analyze` or `dart analyze` | `flutter test` or `dart test` | Flutter stable |
| script | `*.sh`, `*.ps1` at the root or in `scripts/`, no other stack | shfmt + ShellCheck, PSScriptAnalyzer (in CI; no local hook; a root `PSScriptAnalyzerSettings.psd1` relaxes rules). markdownlint is left out: it fails most existing READMEs on line length | repo-declared command, if any | ubuntu-latest, windows-latest |
| java | `pom.xml`, `build.gradle`, `build.gradle.kts` | Spotless (google-java-format) through the build | `mvn -B verify` or `./gradlew check` | Temurin 17, 21 |
| dotnet | `*.sln`, `*.csproj` | `dotnet format --verify-no-changes` | `dotnet test` | .NET 8.0, 9.0 |
| go | `go.mod` | `gofmt`, `go vet` | `go test ./...` | Go stable |
| rust | `Cargo.toml` | `cargo fmt --check`, `cargo clippy -D warnings` | `cargo test` | Rust stable |
| kotlin | a Gradle build applying a Kotlin plugin (takes precedence over java; Android is refused) | ktlint or Spotless through the build | `./gradlew check` | Temurin 17, 21 |
| php | `composer.json` | `composer validate --strict`, php-cs-fixer and PHPStan when configured | `composer test`, else PHPUnit when configured | PHP 8.3, 8.4 |
| ruby | `Gemfile` | RuboCop when configured | RSpec, else `rake test` for minitest | Ruby 3.3, 3.4 |

A repository may list several packs; each contributes its commands, CI job and ecosystems.

| Pack | Release type | Gitignore templates | Dependabot ecosystems |
| --- | --- | --- | --- |
| node | `node` | `Node` | `npm` |
| python | `python` | `Python` | `pip` |
| dart | `dart` | `Dart` (github/gitignore has no Flutter template; the `.gitignore` that `flutter create` writes stays outside repokeeper's block) | `pub` |
| script | `simple` | none | none |
| java | `maven` for Maven; `simple` with `gradle.properties` `version` as an extra file for Gradle | `Java`, plus `Maven` or `Gradle` | `maven` or `gradle` |
| dotnet | `simple` with the `<Version>` element of `Directory.Build.props` (or the single `*.csproj`) as an extra file | `VisualStudio` | `nuget` |
| go | `go` (version from tags) | `Go` | `gomod` |
| rust | `rust`; `simple` for a workspace root without a package | `Rust` | `cargo` |
| kotlin | `simple` with `gradle.properties` as an extra file | `Kotlin`, `Gradle` | `gradle` |
| php | `php` | `Composer` | `composer` |
| ruby | `ruby` with `lib/<gem>/version.rb` as `version-file` | `Ruby` | `bundler` |

release-please has no .NET release type, so the dotnet pack uses `simple` and updates the version
through the generic XML updater.

## 6. Reusable workflows

Hosted in this repository under `.github/workflows/`:

`stack-node.yml`, `stack-python.yml`, `stack-dart.yml`, `stack-script.yml`, `stack-java.yml`,
`stack-dotnet.yml`, `commitlint.yml`,
`release-please.yml` (not `release.yml`, which is the caller path in every repository, this one included).

The caller workflow a repository receives:

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  node:
    uses: vannt-dev/repokeeper/.github/workflows/stack-node.yml@v1
    with:
      node-versions: '["22","24"]'
  commits:
    uses: vannt-dev/repokeeper/.github/workflows/commitlint.yml@v1
```

- `@v1` is a moving major tag, advanced on every 1.x release; repositories may pin `@v1.x.y`.
- Inputs cover versions, optional typecheck, a custom test command and a working directory.
- Every third-party action inside the reusable workflows is pinned by commit SHA, and each job
  declares the minimum `permissions`.
- A repository may add its own jobs to `ci.yml`; `check` only verifies the jobs repokeeper manages.

## 7. Commands and sync behaviour

| Command | Behaviour |
| --- | --- |
| `repokeeper init [--stack …] [--adopt …] [--dry-run]` | Detect stacks, write `.repokeeper.yml`, plan, write outputs and the lock file |
| `repokeeper check [--json]` | Plan and compare without writing; exit 1 on any drift |
| `repokeeper update [--accept <path>] [--dry-run] [--force]` | Move to the standard bundled with the installed version and resync |
| `repokeeper github apply [--yes] [--dry-run]` | Diff hosting settings against config; apply after confirmation |

Update decision per output:

| State | Action |
| --- | --- |
| Missing | Create |
| Matches the lock hash (user did not edit) | Replace with the new content |
| Differs from the lock hash (user edited) | Keep; write `<path>.repokeeper-new` and print a diff. `--accept <path>` takes the new content; adding the path to `owned` stops managing it |
| Block present | Replace the block body only |
| JSON key matches the lock value | Replace; otherwise treat as user-edited |
| Module disabled | Delete outputs whose content still matches the lock hash; keep and report edited ones |

`check` reports: missing outputs, user-edited outputs, outputs from an older standard version,
invalid config and a missing or corrupt lock file. Writes refuse to touch files with uncommitted
changes unless `--force` is given. After a write, repokeeper prints a summary and the suggested
commit message `chore(repokeeper): update standard to <version>`.

## 8. GitHub settings

`repokeeper github apply` reads the `github:` section, fetches current settings through the REST API
and prints a diff. It applies changes only with `--yes` or an interactive confirmation. Only the keys
present in `github:` are managed. `required_checks` has no default: check names must match the check
runs pull requests show (such as `commits / commitlint`), and a wrong name would block every merge.

Managed: a repository ruleset named `repokeeper` targeting the default branch (required pull request,
required status checks, no force push) — rulesets rather than legacy branch protection, which
repokeeper leaves untouched — allowed merge methods, delete-branch-on-merge, Dependabot alerts and
security updates, description and topics.

Never touched: repository deletion, visibility, secrets, collaborators.

Authentication comes from `GITHUB_TOKEN` or `gh auth token`. A missing scope is reported by name.

## 9. Error handling

- Config errors name the key and line and exit 2.
- Network or API failures leave the working tree untouched and exit 3.
- A corrupt or missing lock file makes `check` exit 1 with a hint to run `repokeeper init --relock`,
  which rebuilds the lock from the current files after confirmation.
- Drift exits 1; success exits 0.

## 10. Testing

- **Unit (Vitest):** config validation, planner output per module and stack, every row of the
  update decision table, block replacement in LF and CRLF files, JSON key merging.
- **Snapshot:** full output for each stack pack rendered into a temporary directory.
- **End-to-end:** temporary git repository — `init`, `check` clean, edit a managed file, `update`
  keeps the edit, `check` reports it.
- **Workflow tests:** this repository's CI runs each reusable workflow against fixture projects in
  `fixtures/node`, `fixtures/python`, `fixtures/dart`, `fixtures/script`, `fixtures/java-maven`,
  `fixtures/java-gradle`, `fixtures/dotnet`.
- **Dogfooding:** repokeeper manages its own repository.

## 11. Releasing repokeeper

GitHub Flow with release-please. `repokeeper` is published from GitHub Actions with npm
provenance. The `v1` tag is moved to each 1.x release.

## 12. Delivery order

1. Skeleton: CLI, config, planner, sync engine, lock file, `init`/`check`/`update` with `--dry-run`.
2. Core modules (editorconfig, commits, hooks, health, gitignore, deps) and the node pack.
3. Reusable workflows, `ci` and `release` modules; pilot on token-efficient-work and
   convert-md-to-pdf.
4. python, dart, script, java and dotnet packs, plus NestJS awareness in the node pack (nest-cli.json;
   `lint` and `test:e2e` scripts); pilot on governed-agent-sdlc, nimbleclip, ai-engineering-skills
   and a Java and a .NET repository.
5. `repokeeper github apply`.
6. Phase 2: go, rust, kotlin, php and ruby packs (done in 0.4.0); a GitLab adapter (GitLab CI
   components, Renovate, semantic-release, protected branches and approvals).
