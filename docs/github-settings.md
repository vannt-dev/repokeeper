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
  protect:                  # a ruleset named "repokeeper"; false removes it
    require_pull_request: true
    required_approvals: 0
    required_checks: ["CI result"]   # the default while modules.ci is on; names as pull requests show them
    require_up_to_date: false        # whether a pull request must hold the latest base branch
    branches: [main, develop]        # left out: the default branch
    allow_force_push: false
```

With `modules.ci` on, `required_checks` defaults to `["CI result"]`: the last job of the generated
`ci.yml`, which waits for every other job and fails when one failed or was cancelled. A job skipped
because a pull request changes only documentation still passes it, so requiring this one check is
safe with `skip_when_only`. A name is required from GitHub Actions; write
`{ context: "Sonar", integration_id: null }` to accept a check from any app.

Before it writes the ruleset, `github apply` reads the repository's workflow files and leaves out,
with a warning, a required check that no job reports: every pull request would wait for it forever.
It keeps the rules it does not manage (allowed merge methods, linear history and so on), the
excluded branches and who may bypass the ruleset. A ruleset written by an earlier repokeeper is
updated once, so that its checks must come from GitHub Actions.

It prints every change first and applies them with `--yes`, or after you confirm in a terminal;
`--dry-run` only prints. The token comes from `GITHUB_TOKEN` or `gh auth token` and needs admin
access to the repository. Legacy branch protection, visibility, secrets and collaborators are never
touched.

Secret scanning and push protection are free on a public repository, where GitHub usually has them
on already. A private repository needs GitHub Secret Protection; without it GitHub refuses the change
and `github apply` reports its answer. Code scanning is not a setting here but a workflow: see
`modules.security` in [CI and releases](ci-and-releases.md#code-scanning).

`merge.auto_merge` is the repository's "Allow auto-merge" setting. With `modules.automerge` on,
`github apply` turns it on even when the line is not written, for Dependabot's workflow and for
Renovate alike; see [Dependabot auto-merge](ci-and-releases.md#dependabot-auto-merge).

---

Back to the [README](../README.md).
