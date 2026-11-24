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
    immutable_releases: true                  # lock a release's assets and tag once published; see below
  autolinks:                # the whole set: one not listed is removed
    - { key_prefix: TICKET-, url_template: "https://tickets.example.com/<num>" }
    - { key_prefix: PR-, url_template: "https://example.com/pr/<num>", is_alphanumeric: false }
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

## Immutable releases

`security.immutable_releases: true` turns on GitHub's
[immutable releases](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases):
once a release is published, its assets cannot be changed or deleted, and its tag cannot be moved
or deleted. The title and notes stay editable. It applies only to releases published after you turn
it on; `false` turns it off. It is off unless you write the line. An organisation can enforce it
for its repositories; GitHub may then refuse to turn it off, and `github apply` reports its answer.

> [!WARNING]
> With immutable releases on, a release takes no new assets once it is published. A workflow that
> creates the release and then uploads assets to it (APKs, zips, binaries) breaks: the upload is
> refused. Create the release as a draft, upload every asset to the draft, and publish it last.
> This includes a job that runs after release-please (`release_created`) and uploads files to the
> release it just published. The release workflow repokeeper writes attaches nothing to the
> release, `modules.publish` included (it publishes to npm or PyPI), so on its own it is unaffected.
> Change such a workflow before you turn this on.

## Autolinks

`autolinks` lists the repository's
[autolink references](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/configuring-autolinks-to-reference-external-resources):
`TICKET-123` in an issue, pull request or commit becomes a link to `url_template` with `<num>`
replaced by `123`. `is_alphanumeric` says whether `<num>` takes letters as well as digits; left out,
it is true, as on GitHub. Like `topics`, the list is the whole set: `github apply` adds a missing
autolink, replaces one whose template or `is_alphanumeric` changed (GitHub cannot edit one, so it is
removed and added again), and removes one the list does not name. `autolinks: []` removes every
autolink; leave the key out to keep the repository's autolinks as they are. Each prefix is a line
of its own in the preview, removals included, so check them before you confirm.

`merge.auto_merge` is the repository's "Allow auto-merge" setting. With `modules.automerge` on,
`github apply` turns it on even when the line is not written (with Dependabot; Renovate merges by
itself); see [Dependabot auto-merge](ci-and-releases.md#dependabot-auto-merge).

---

Back to the [README](../README.md).
