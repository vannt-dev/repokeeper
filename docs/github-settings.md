# GitHub settings

`repokeeper github apply` brings the repository's settings in line with the `github:` section of
`.repokeeper.yml`. Only the keys you write are managed; anything left out stays as it is.

```yaml
github:
  description: Keeps repositories on one standard
  topics: [cli, conventional-commits]
  merge: { squash: true, merge_commit: false, rebase: false, delete_branch_on_merge: true, auto_merge: true }
  security:
    dependabot_alerts: true
    dependabot_security_updates: true
    secret_scanning: true                     # GitHub's scan for committed credentials
    secret_scanning_push_protection: true     # refuse a push that contains one; needs secret_scanning
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

Secret scanning and push protection are free on a public repository, where GitHub usually has them
on already. A private repository needs GitHub Secret Protection; without it GitHub refuses the change
and `github apply` reports its answer. Code scanning is not a setting here but a workflow: see
`modules.security` in [CI and releases](ci-and-releases.md#code-scanning).

`merge.auto_merge` is the repository's "Allow auto-merge" setting. With `modules.automerge` on,
`github apply` turns it on even when the line is not written; see
[Dependabot auto-merge](ci-and-releases.md#dependabot-auto-merge).

---

Back to the [README](../README.md).
