# GitLab

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

---

Back to the [README](../README.md).
