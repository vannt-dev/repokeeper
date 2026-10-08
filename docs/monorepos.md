# Monorepos

A stack does not have to sit at the root. When the root holds no project, `init` looks one level
down and records where each stack lives:

```yaml
stacks: [node, go]
stack_options:
  node: { directory: frontend }
  go: { directory: backend }
```

Each CI job then runs in its folder, each git hook runs there and only sees that folder's staged
files, Dependabot watches each folder, and `CONTRIBUTING.md` says where to run each install command.
Name the folder yourself with `repokeeper init --stack go:backend --stack node:frontend`, or add
`directory` to a stack's options later and run `repokeeper update`.

What to know:

- One folder per stack. A second folder of the same stack (`admin/` beside `web/`, both Node.js) is
  reported by `init` and left out.
- One release per repository, as before: the first stack with a version of its own is the one
  release-please releases, from its folder, and only commits that touch that folder count towards it.
- With the Node.js project in a folder, repokeeper adds nothing to its `package.json`: commitlint and
  lefthook run through `npx`, so contributors run `npx lefthook install` once.
- GitHub only for now; on GitLab a stack has to be at the root.

---

Back to the [README](../README.md).
