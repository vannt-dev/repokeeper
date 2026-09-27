# repokeeper

Keep every repository on one maintained standard: Conventional Commits, git hooks, community health
files, editor and gitignore settings, Dependabot, CI and releases — applied once and kept in sync as
the standard evolves.

> Status: early development. Supported stacks: Node.js (including NestJS), Python, Dart and
> Flutter, shell and PowerShell scripts, Java (Maven and Gradle) and .NET, each with CI and releases.
> GitHub settings are on the way. See the [design](docs/superpowers/specs/2026-09-25-repokeeper-design.md).

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

Requires Node.js 22.12 or newer.

## CI and releases

`ci.yml` and `release.yml` call reusable workflows from this repository (`stack-node.yml`,
`commitlint.yml`, `release-please.yml`) at the moving major tag, so fixes reach every repository
without a pull request. repokeeper owns the `name`, `on` and `permissions` keys and the jobs it
adds; jobs you add yourself are left alone, and so is the formatting of the rest of the file.

The script stack runs ShellCheck and `shfmt -d` on `*.sh` (format with `shfmt -w` before pushing)
and PSScriptAnalyzer on `*.ps1`, which fails on warnings too. To relax a rule, add a
`PSScriptAnalyzerSettings.psd1` at the repository root; PSScriptAnalyzer picks it up on its own:

```powershell
@{
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
  GitHub does not run CI on pull requests opened that way.

## License

MIT
