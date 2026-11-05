# Shared settings (`extends`)

Many repositories of one organisation want the same modules, the same branch protection, the same
code owners. Rather than repeat them in every `.repokeeper.yml`, put them in a shared file and name
it under `extends`:

```yaml
# .repokeeper.yml
extends:
  - github:acme/standards/repokeeper/org.yml@v3   # the organisation
  - ../shared/web-team.yml                        # the group
schema: 1
standard: 1.6.0
stacks: [node]
```

```yaml
# repokeeper/org.yml in acme/standards
platform: github
modules:
  security: true
  health:
    license: MIT
    copyright: 2026 Acme Ltd
    contact: https://github.com/acme
    codeowners: ["@acme/maintainers"]
github:
  protect:
    required_checks: [CI result]
```

## Sources

`extends` takes one source or a list of them. A source is:

- **a path**, relative to the file that names it, such as `../shared/web-team.yml`;
- **`github:owner/repo/path/to/file.yml`**, read through the GitHub API, with an optional `@ref`
  (a branch, a tag or a commit) after it. Without one, the repository's default branch is read.
  Name a tag or a commit to decide yourself when a change to the shared file reaches a repository.

A shared file may itself have `extends`. A path in a file read from GitHub names another file of
that repository, at the same ref. Chains are followed depth first, up to 5 files deep; a file that
comes round again is an error, and a file two others extend is merged once, where it is first
reached.

## How the files are merged

The sources are merged in the order they are listed, each after the files it extends, and the
repository's own file last, so a later file overrides an earlier one:

- **mappings** merge key by key, so `modules.security: true` in the shared file and
  `modules.ci: false` in the repository's file both apply;
- **lists replace**: `stacks`, `owned`, `required_checks` or `codeowners` in a later file replace the
  whole list of an earlier one, they are never added together;
- **anything else replaces**, a value of another kind included: `health: false` in the repository's
  file switches off a `health` mapping it inherited.

A shared file need not be a complete configuration; only the merged result is checked. An error
names the file, and the line, the key was taken from: `../shared/web-team.yml:4: modules.hoks is not
a known key`. A required key missing from every file is reported against `.repokeeper.yml`; one
missing inside a mapping that several files build, such as `modules.health`, at the last file that
sets that mapping, which need not be the file you meant to put it in.

`standard` is the one key a shared file may not set: each repository names the standard it is on
in its own file, and `repokeeper update` moves that line there. `update`, `init` and `eject` write
only the repository's own file and only the lines they change; nothing inherited is copied into it.

## Reading from GitHub

The token comes from `GITHUB_TOKEN` or `gh auth token`; without one, a public repository is still
read, at GitHub's lower rate limit for requests without a token. When a source cannot be read
(offline, not found, rate limited) the command stops with an error that names the source and the
reason, and writes nothing.

In CI, the drift check (`modules.drift`) runs with the workflow's `GITHUB_TOKEN`, which reads public
repositories and the repository the workflow runs in, but no other private one. Keep a shared file
that private repositories extend in a public repository, or in the same repository as a path.
