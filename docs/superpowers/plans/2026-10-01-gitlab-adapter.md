# GitLab Adapter (node) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `repokeeper init --platform gitlab` gives a node repository on GitLab the same standard as on GitHub: community files, Renovate, a generated `.gitlab-ci.yml` and semantic-release.

**Architecture:** A second `PlatformAdapter` (`src/platforms/gitlab.ts`) renders every platform-specific output. The configuration carries `platform: gitlab`; `buildContext` picks the adapter. The CI file is written as managed top-level YAML keys, one per job, so jobs the user adds are kept. Platform wording used outside the adapter (SECURITY.md, CONTRIBUTING.md, the contact URL) comes from three new adapter members.

**Tech Stack:** TypeScript (ESM), vitest, biome, `yaml`, ajv.

**Spec:** `docs/superpowers/specs/2026-10-01-gitlab-adapter-design.md`

## Global Constraints

- No output of a GitHub repository changes. `STANDARD_VERSION` stays `1.4.3`. No existing GitHub test expectation is edited, except the one line in `test/git.test.ts` that is moved in Task 1.
- Only the `node` stack is supported on gitlab. Any other stack fails with exactly: `stack "<id>" is not supported on gitlab yet (supported: node)`.
- CI logic is generated into the repository's `.gitlab-ci.yml`: no `include`, no CI components.
- Jobs use GitLab's default stages `test` and `deploy`; no `stages` key is written. Every job carries its own `rules`.
- Tool versions are pinned in `TOOL_VERSIONS`: semantic-release `25.0.9`, `@semantic-release/changelog` `7.0.0`, `@semantic-release/git` `11.0.1`, `@semantic-release/gitlab` `13.3.3`, `conventional-changelog-conventionalcommits` `10.4.0`, renovate `44.128.1`.
- Strings that contain `${` and are not JavaScript templates need a `// biome-ignore lint/suspicious/noTemplateCurlyInString: <reason>` comment on the line above, as `src/platforms/github.ts` does.
- Write files that contain backslashes with the editor, never through a shell heredoc (it collapses `\\` into `\` in this environment).
- Commit messages follow commitlint (header ≤ 100 characters, body lines ≤ 100) and carry no trailers.
- Verify with `npm test`, `npm run lint`, `npx tsc --noEmit -p .`, and `node dist/cli.js check` after `npm run build`.

## Review Focus

1. **A merged results pipeline** has a merge commit as `CI_COMMIT_SHA`; commit linting must stop at the head of the source branch. Pinned in Task 4 (`lints up to the source branch head`).
2. **The ci module off while release or deps stay on:** the `release` and `renovate` jobs must be valid on their own. Pinned in Task 5 (`release and renovate jobs stand alone`).
3. **Remotes with credentials, a port, nested groups or a self-hosted host.** Pinned in Task 1 (`parses GitLab remotes`).
4. **Jobs the user wrote in `.gitlab-ci.yml`** survive `init` and `update`. Pinned in Task 4 (`keeps the user's own jobs`).
5. **A self-hosted GitLab** gets its own host in SECURITY.md and the contact URL, not `gitlab.com`. Pinned in Task 3 (`uses the remote's host`).

Not testable here, checked in the pilot: a formatter hook (prettier or biome) in the target repository may reformat the generated `renovate.json` or `.releaserc.json` and make `check` report drift; and the pipeline's validity on GitLab itself.

## File Structure

- `src/git.ts` — add `parseRemote`, `remoteHost`; `repoInfo` takes the platform.
- `src/config/types.ts`, `src/config/schema.ts`, `src/config/load.ts` — `platform: gitlab`, the `gitlab` key.
- `src/model.ts` — `PlatformAdapter` gains `stacks`, `changeRequest`, `profileUrl`, `securityReport`; `RepoInfo.host`.
- `src/platforms/gitlab.ts` — the adapter (new).
- `src/platforms/index.ts` — `platformFor` (new).
- `src/platforms/github.ts` — the three new members, same text as today.
- `src/modules/health.ts` — takes wording from the adapter.
- `src/commands/context.ts`, `init.ts`, `github.ts`, `report.ts`, `src/cli.ts` — selection, flag, guard, note.
- `src/version.ts` — tool pins.
- Tests: `test/git.test.ts`, `test/config-gitlab.test.ts`, `test/platforms-gitlab.test.ts`, `test/e2e-gitlab.test.ts`, `test/helpers.ts`.

---

### Task 1: GitLab remotes

**Files:**
- Modify: `src/git.ts`, `src/model.ts` (`RepoInfo`), `src/config/types.ts` (`PlatformId` only)
- Test: `test/git.test.ts`

**Interfaces:**
- Produces:
  - `type PlatformId = "github" | "gitlab"` (in `src/config/types.ts`);
  - `interface Remote { host: string; owner: string; name: string }`;
  - `parseRemote(url: string): Remote | null`;
  - `remoteHost(root: string): Promise<string | null>`;
  - `repoInfo(root: string, platform?: PlatformId): Promise<RepoInfo>` (default `"github"`);
  - `RepoInfo.host?: string | null`.

- [ ] **Step 1: Write the failing tests.** In `test/git.test.ts`:

Change the import line to:

```ts
import { dirtyPaths, isGitRepo, parseRemote, parseRemoteUrl, remoteHost, repoInfo } from "../src/git.js";
```

Append:

```ts
it("parses GitLab remotes with nested groups, credentials, ports and self-hosted hosts", () => {
  expect(parseRemote("https://gitlab.com/acme/tools/demo.git")).toEqual({
    host: "gitlab.com",
    owner: "acme/tools",
    name: "demo",
  });
  expect(parseRemote("git@gitlab.com:acme/demo.git\n")).toEqual({ host: "gitlab.com", owner: "acme", name: "demo" });
  expect(parseRemote("ssh://git@GitLab.Example.com:2222/acme/tools/sub/demo.git")).toEqual({
    host: "gitlab.example.com",
    owner: "acme/tools/sub",
    name: "demo",
  });
  expect(parseRemote("https://oauth2:secret@gitlab.com/acme/demo/")).toEqual({
    host: "gitlab.com",
    owner: "acme",
    name: "demo",
  });
});

it("rejects remotes without a host and a namespace", () => {
  for (const url of ["C:/work/demo", "file:///srv/git/demo.git", "../demo", "https://gitlab.com/demo.git", ""]) {
    expect(parseRemote(url)).toBeNull();
  }
});

it("reads the repository from a GitLab remote only on the gitlab platform", async () => {
  const dir = await tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@gitlab.example.com:acme/tools/demo.git"], { cwd: dir });

  expect(await remoteHost(dir)).toBe("gitlab.example.com");
  expect(await repoInfo(dir, "gitlab")).toMatchObject({ host: "gitlab.example.com", owner: "acme/tools", name: "demo" });
  expect((await repoInfo(dir)).owner).toBeNull();
  expect(await remoteHost(await tempDir())).toBeNull();
});
```

The existing line `expect(parseRemoteUrl("https://gitlab.com/a/b.git")).toBeNull();` stays: `parseRemoteUrl` remains GitHub-only.

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `npx vitest run test/git.test.ts`
Expected: FAIL — `parseRemote` and `remoteHost` are not exported.

- [ ] **Step 3: Implement.**

`src/config/types.ts`, after the `StackId` line:

```ts
export type PlatformId = "github" | "gitlab";
```

`src/model.ts`, in `RepoInfo`, after `name: string;`:

```ts
  /** Host of the origin remote; absent on GitHub, where it is always github.com. */
  host?: string | null;
```

`src/git.ts`: add `import type { PlatformId } from "./config/types.js";`, then replace `repoInfo` with the following and leave `parseRemoteUrl` as it is:

```ts
export interface Remote {
  host: string;
  owner: string;
  name: string;
}

/** Any hosted remote, HTTPS or SSH. The owner is the whole namespace path, because GitLab groups nest. */
export function parseRemote(url: string): Remote | null {
  const text = url.trim();
  const match =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(text) ??
    /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(text);
  if (!match) return null;
  const host = (match[1] as string).toLowerCase();
  const segments = (match[2] as string)
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  const name = segments.pop();
  // a host has a dot, which rules out drive letters and file: URLs
  if (!host.includes(".") || name === undefined || segments.length === 0) return null;
  return { host, owner: segments.join("/"), name };
}

async function originUrl(root: string): Promise<string | null> {
  return git(root, ["remote", "get-url", "origin"]);
}

/** Host of the origin remote, or null without one. */
export async function remoteHost(root: string): Promise<string | null> {
  const url = await originUrl(root);
  return url ? (parseRemote(url)?.host ?? null) : null;
}

export async function repoInfo(root: string, platform: PlatformId = "github"): Promise<RepoInfo> {
  const url = await originUrl(root);
  const remote = url ? (platform === "gitlab" ? parseRemote(url) : parseRemoteUrl(url)) : null;
  return { ...(remote ?? { owner: null, name: basename(root) }), releasedVersion: await latestReleaseVersion(root) };
}
```

- [ ] **Step 4: Run the tests and confirm they pass.**
Run: `npx vitest run test/git.test.ts && npx tsc --noEmit -p .`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit.**

```bash
git add src/git.ts src/model.ts src/config/types.ts test/git.test.ts
git commit -m "feat(git): read GitLab remotes with nested groups and self-hosted hosts"
```

---

### Task 2: `platform: gitlab` in the configuration

**Files:**
- Modify: `src/config/types.ts`, `src/config/schema.ts`, `src/config/load.ts`
- Test: `test/config-gitlab.test.ts` (create)

**Interfaces:**
- Consumes: `PlatformId` (Task 1).
- Produces:
  - `RepokeeperConfig.platform: PlatformId`;
  - `RepokeeperConfig.gitlab?: GitlabSettings`, `interface GitlabSettings { default_branch?: string }`;
  - `defaultBranch(config)` reads the key of the configured platform;
  - `defaultConfig({ ..., platform?: PlatformId })`.

- [ ] **Step 1: Write the failing tests** in `test/config-gitlab.test.ts`:

```ts
import { expect, it } from "vitest";
import { parseConfig, renderConfig } from "../src/config/load.js";
import { defaultBranch, defaultConfig } from "../src/config/types.js";

const base = "schema: 1\nstandard: 1.0.0\nplatform: gitlab\nstacks: [node]\nmodules:\n  health: false\n";

it("accepts the gitlab platform and its default branch", () => {
  expect(parseConfig(base).platform).toBe("gitlab");
  expect(defaultBranch(parseConfig(base))).toBe("main");
  expect(defaultBranch(parseConfig(`${base}gitlab:\n  default_branch: trunk\n`))).toBe("trunk");
});

it("rejects the other platform's key, naming it and its line", () => {
  expect(() => parseConfig(`${base}github:\n  default_branch: trunk\n`)).toThrow(
    ".repokeeper.yml:7: github is not used on the gitlab platform",
  );
  const github = base.replace("platform: gitlab", "platform: github");
  expect(() => parseConfig(`${github}gitlab:\n  default_branch: trunk\n`)).toThrow(
    ".repokeeper.yml:7: gitlab is not used on the github platform",
  );
});

it("rejects unknown gitlab keys and unknown platforms", () => {
  expect(() => parseConfig(`${base}gitlab:\n  protect: false\n`)).toThrow("gitlab.protect is not a known key");
  expect(() => parseConfig(base.replace("gitlab", "bitbucket"))).toThrow("platform must be one of: github, gitlab");
});

it("builds and renders a gitlab default config that parses back", () => {
  const config = defaultConfig({
    stacks: ["node"],
    standard: "1.4.3",
    copyright: "2026 Demo",
    contact: "https://gitlab.com/acme",
    codeowners: ["@acme/tools"],
    platform: "gitlab",
  });
  expect(config.platform).toBe("gitlab");
  expect(parseConfig(renderConfig(config)).platform).toBe("gitlab");
  expect(defaultConfig({ stacks: ["node"], standard: "1.4.3", copyright: "c", contact: "c", codeowners: [] }).platform).toBe(
    "github",
  );
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `npx vitest run test/config-gitlab.test.ts`
Expected: FAIL — `platform must be one of: github`.

- [ ] **Step 3: Implement.**

`src/config/types.ts`:

```ts
export interface GitlabSettings {
  default_branch?: string;
}
```

In `RepokeeperConfig`: change `platform: "github";` to `platform: PlatformId;` and add `gitlab?: GitlabSettings;` after `github?: GithubSettings;`.

Replace `defaultBranch` and its comment:

```ts
/** The branch CI runs on and contributors branch from: `default_branch` of the configured platform, or `main`. */
export function defaultBranch(config: RepokeeperConfig): string {
  const branch = (config.platform === "gitlab" ? config.gitlab : config.github)?.default_branch;
  return typeof branch === "string" && branch.length > 0 ? branch : "main";
}
```

In `defaultConfig`: add `platform?: PlatformId;` to the input type and replace `platform: "github",` with `platform: input.platform ?? "github",`.

`src/config/schema.ts`: change `platform: { enum: ["github"] },` to `platform: { enum: ["github", "gitlab"] },` and add after the `github` property:

```ts
    gitlab: {
      type: "object",
      additionalProperties: false,
      properties: { default_branch: { type: "string", minLength: 1 } },
    },
```

`src/config/load.ts`, in `parseConfig`, replace the final `return withDefaults(...)` statement with:

```ts
  const typed = data as Partial<RepokeeperConfig> &
    Pick<RepokeeperConfig, "schema" | "standard" | "platform" | "stacks">;
  const other = typed.platform === "gitlab" ? "github" : "gitlab";
  if (typed[other] !== undefined) {
    throw new ConfigError(
      `${CONFIG_FILE}:${lineOf(doc, lineCounter, [other])}: ${other} is not used on the ${typed.platform} platform`,
    );
  }
  return withDefaults(typed);
```

and in `withDefaults`, after the `github` line:

```ts
  if (data.gitlab !== undefined) config.gitlab = data.gitlab;
```

- [ ] **Step 4: Run the tests and confirm they pass.**
Run: `npx vitest run test/config-gitlab.test.ts test/config.test.ts && npx tsc --noEmit -p .`
Expected: all pass. If `tsc` reports `PlatformAdapter.id` or another `"github"` literal no longer matching, leave it: Task 3 changes those types. Fix only errors inside `src/config/`.

- [ ] **Step 5: Commit.**

```bash
git add src/config test/config-gitlab.test.ts
git commit -m "feat(config): accept the gitlab platform and its default branch"
```

---

### Task 3: The adapter, its community files and platform wording

**Files:**
- Create: `src/platforms/gitlab.ts`, `src/platforms/index.ts`
- Modify: `src/model.ts`, `src/platforms/github.ts`, `src/modules/health.ts`, `src/commands/context.ts`, `test/helpers.ts`
- Test: `test/platforms-gitlab.test.ts` (create)

**Interfaces:**
- Consumes: `PlatformId`, `repoInfo(root, platform)`, `RepoInfo.host`.
- Produces:
  - `PlatformAdapter` members: `id: PlatformId`, `stacks: readonly StackId[]`, `changeRequest: string`, `profileUrl(repo: RepoInfo): string | null`, `securityReport(repo: RepoInfo): string`;
  - `gitlabPlatform: PlatformAdapter` (in `src/platforms/gitlab.ts`); its `dependencyUpdates`, `ciWorkflow` and `releaseAutomation` return `[]` until Tasks 4 and 5;
  - `platformFor(id: PlatformId): PlatformAdapter` (in `src/platforms/index.ts`);
  - `gitlabContext(overrides?)` in `test/helpers.ts`, same parameter as `makeContext`.

- [ ] **Step 1: Add the test helper.** In `test/helpers.ts`, add `import { gitlabPlatform } from "../src/platforms/gitlab.js";` and append:

```ts
/** `makeContext` for a repository on GitLab. */
export function gitlabContext(overrides: Parameters<typeof makeContext>[0] = {}): ModuleContext {
  const ctx = makeContext({
    ...overrides,
    config: { platform: "gitlab", ...overrides.config },
    repo: overrides.repo ?? { host: "gitlab.com", owner: "acme/tools", name: "example" },
  });
  return { ...ctx, platform: gitlabPlatform };
}
```

- [ ] **Step 2: Write the failing tests** in `test/platforms-gitlab.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/commands/context.js";
import { parseConfig } from "../src/config/load.js";
import type { Output } from "../src/model.js";
import { healthModule } from "../src/modules/health.js";
import { githubPlatform } from "../src/platforms/github.js";
import { platformFor } from "../src/platforms/index.js";
import { gitlabContext, makeContext, tempDir } from "./helpers.js";

const files = (outputs: Output[]) =>
  Object.fromEntries(outputs.flatMap((o) => (o.kind === "file" ? [[o.path, o.content]] : [])));

describe("gitlab community files", () => {
  it("writes issue and merge request templates and CODEOWNERS under .gitlab", () => {
    const out = files(healthModule.outputs(gitlabContext()));
    expect(out[".gitlab/issue_templates/Bug.md"]).toContain("## What happened?");
    expect(out[".gitlab/issue_templates/Bug.md"]).toMatch(/\n\/label ~bug\n$/);
    expect(out[".gitlab/issue_templates/Feature.md"]).toContain("## What problem would this solve?");
    expect(out[".gitlab/issue_templates/Feature.md"]).toMatch(/\n\/label ~enhancement\n$/);
    expect(out[".gitlab/merge_request_templates/Default.md"]).toContain("- [ ] Tests added or updated");
    expect(out[".gitlab/CODEOWNERS"]).toMatch(/\n\* @vannt-dev\n$/);
    expect(Object.keys(out).some((path) => path.startsWith(".github/"))).toBe(false);
  });

  it("leaves CODEOWNERS out without owners", () => {
    const health = { license: "MIT", copyright: "2026 Demo", contact: "x", codeowners: [] };
    const out = files(healthModule.outputs(gitlabContext({ modules: { health } })));
    expect(out[".gitlab/CODEOWNERS"]).toBeUndefined();
  });
});

describe("platform wording", () => {
  it("asks for a confidential issue and a merge request on gitlab", () => {
    const out = files(healthModule.outputs(gitlabContext()));
    expect(out["SECURITY.md"]).toContain(
      "by opening a [confidential issue](https://gitlab.com/acme/tools/example/-/issues/new?issue%5Bconfidential%5D=true)",
    );
    expect(out["SECURITY.md"]).not.toContain("github");
    expect(out["CONTRIBUTING.md"]).toContain("3. Open a merge request.");
  });

  it("uses the remote's host on a self-hosted GitLab", () => {
    const repo = { host: "git.example.org", owner: "acme", name: "example" };
    expect(files(healthModule.outputs(gitlabContext({ repo })))["SECURITY.md"]).toContain(
      "https://git.example.org/acme/example/-/issues/new",
    );
    expect(platformFor("gitlab").profileUrl(repo)).toBe("https://git.example.org/acme");
  });

  it("falls back to plain wording without a remote", () => {
    const repo = { owner: null, name: "example" };
    expect(files(healthModule.outputs(gitlabContext({ repo })))["SECURITY.md"]).toContain(
      "by opening a confidential issue in the repository",
    );
    expect(platformFor("gitlab").profileUrl(repo)).toBeNull();
  });

  it("keeps the GitHub wording", () => {
    const out = files(healthModule.outputs(makeContext()));
    expect(out["CONTRIBUTING.md"]).toContain("3. Open a pull request.");
    expect(githubPlatform.profileUrl({ owner: "vannt-dev", name: "example" })).toBe("https://github.com/vannt-dev");
    expect(githubPlatform.profileUrl({ owner: null, name: "example" })).toBeNull();
  });
});

describe("platform selection", () => {
  const config = (platform: string, stack: string) =>
    parseConfig(`schema: 1\nstandard: 1.0.0\nplatform: ${platform}\nstacks: [${stack}]\nmodules:\n  health: false\n`);

  it("builds the context with the configured platform's adapter", async () => {
    const root = await tempDir();
    await writeFile(join(root, "package.json"), "{}\n");
    expect((await buildContext(root, config("gitlab", "node"))).platform.id).toBe("gitlab");
    expect((await buildContext(root, config("github", "node"))).platform.id).toBe("github");
  });

  it("refuses a stack gitlab does not support yet", async () => {
    await expect(buildContext(await tempDir(), config("gitlab", "python"))).rejects.toThrow(
      'stack "python" is not supported on gitlab yet (supported: node)',
    );
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail.**
Run: `npx vitest run test/platforms-gitlab.test.ts`
Expected: FAIL — `src/platforms/gitlab.js` and `src/platforms/index.js` do not exist.

- [ ] **Step 4: Implement.**

`src/model.ts`: import `PlatformId` and `StackId` from `./config/types.js` if not already imported, then replace the head of `PlatformAdapter`:

```ts
export interface PlatformAdapter {
  id: PlatformId;
  /** Stacks whose CI and release this platform can render. */
  stacks: readonly StackId[];
  /** What the platform calls a proposed change. */
  changeRequest: "pull request" | "merge request";
  /** Page of the repository's owner, or null when the remote is unknown. */
  profileUrl(repo: RepoInfo): string | null;
  /** How to report a vulnerability privately: the words after "Report the vulnerability privately ". */
  securityReport(repo: RepoInfo): string;
  communityFiles(ctx: ModuleContext): Output[];
```

(The four existing methods stay below, unchanged.)

`src/platforms/github.ts`: add `import { STACK_IDS } from "../config/types.js";` (merge with the existing import from that file) and, directly after `id: "github",`:

```ts
  stacks: STACK_IDS,
  changeRequest: "pull request",
  profileUrl: (repo) => (repo.owner ? `https://github.com/${repo.owner}` : null),
  securityReport: (repo) =>
    repo.owner
      ? `through [GitHub security advisories](https://github.com/${repo.owner}/${repo.name}/security/advisories/new)`
      : "through the repository's Security tab (Report a vulnerability)",
```

`src/modules/health.ts`: delete the `const report = owner ? ... : ...;` statement and the now unused `const { owner, name } = ctx.repo;`, add in their place:

```ts
    const report = ctx.platform.securityReport(ctx.repo);
```

and in the CONTRIBUTING text change `3. Open a pull request. It is merged` to `3. Open a ${ctx.platform.changeRequest}. It is merged`.

Create `src/platforms/gitlab.ts`:

```ts
import { MANAGED_HEADER, type ModuleContext, type Output, type PlatformAdapter, type RepoInfo } from "../model.js";

const md = (path: string, body: string): Output => ({
  kind: "file",
  module: "health",
  path,
  content: `<!-- ${MANAGED_HEADER} -->\n\n${body}`,
});

/** Web address of the GitLab instance the repository lives on. */
const baseUrl = (repo: RepoInfo) => `https://${repo.host ?? "gitlab.com"}`;

export const gitlabPlatform: PlatformAdapter = {
  id: "gitlab",
  stacks: ["node"],
  changeRequest: "merge request",

  profileUrl: (repo) => (repo.owner ? `${baseUrl(repo)}/${repo.owner}` : null),

  securityReport: (repo) =>
    repo.owner
      ? `by opening a [confidential issue](${baseUrl(repo)}/${repo.owner}/${repo.name}/-/issues/new?issue%5Bconfidential%5D=true)`
      : "by opening a confidential issue in the repository",

  communityFiles(ctx: ModuleContext): Output[] {
    const outputs: Output[] = [
      md(
        ".gitlab/issue_templates/Bug.md",
        "## What happened?\n\n<!-- Include the steps to reproduce it. -->\n\n## What did you expect?\n\n## Version\n\n/label ~bug\n",
      ),
      md(
        ".gitlab/issue_templates/Feature.md",
        "## What problem would this solve?\n\n## What do you propose?\n\n/label ~enhancement\n",
      ),
      md(
        ".gitlab/merge_request_templates/Default.md",
        "## Summary\n\n## Testing\n\n- [ ] Tests added or updated\n- [ ] Commit messages follow Conventional Commits\n",
      ),
    ];
    const health = ctx.config.modules.health;
    if (health && health.codeowners.length > 0) {
      outputs.push({
        kind: "file",
        module: "health",
        path: ".gitlab/CODEOWNERS",
        content: `# ${MANAGED_HEADER}\n* ${health.codeowners.join(" ")}\n`,
      });
    }
    return outputs;
  },

  dependencyUpdates: () => [],
  ciWorkflow: () => [],
  releaseAutomation: () => [],
};
```

Create `src/platforms/index.ts`:

```ts
import type { PlatformId } from "../config/types.js";
import type { PlatformAdapter } from "../model.js";
import { githubPlatform } from "./github.js";
import { gitlabPlatform } from "./gitlab.js";

export function platformFor(id: PlatformId): PlatformAdapter {
  return id === "gitlab" ? gitlabPlatform : githubPlatform;
}
```

Replace `src/commands/context.ts` with:

```ts
import type { RepokeeperConfig } from "../config/types.js";
import { UsageError } from "../errors.js";
import { repoInfo } from "../git.js";
import type { ModuleContext, RepoInfo } from "../model.js";
import { platformFor } from "../platforms/index.js";
import { getStackPack } from "../stacks/index.js";

export async function buildContext(root: string, config: RepokeeperConfig, repo?: RepoInfo): Promise<ModuleContext> {
  const platform = platformFor(config.platform);
  const unsupported = config.stacks.find((id) => !platform.stacks.includes(id));
  if (unsupported) {
    throw new UsageError(
      `stack "${unsupported}" is not supported on ${platform.id} yet (supported: ${platform.stacks.join(", ")})`,
    );
  }
  const stacks = await Promise.all(
    config.stacks.map((id) => getStackPack(id).resolve(root, config.stack_options[id] ?? {})),
  );
  return { config, stacks, platform, repo: repo ?? (await repoInfo(root, config.platform)) };
}
```

- [ ] **Step 5: Run the tests and confirm they pass.**
Run: `npm test && npx tsc --noEmit -p . && npm run lint`
Expected: all pass, including every existing health test (the GitHub text is byte-identical).

- [ ] **Step 6: Commit.**

```bash
git add src test
git commit -m "feat(gitlab): add the platform adapter with community files and wording"
```

---

### Task 4: `.gitlab-ci.yml` — node, commits and drift jobs

**Files:**
- Modify: `src/platforms/gitlab.ts`, `src/commands/report.ts`
- Test: `test/platforms-gitlab.test.ts`

**Interfaces:**
- Consumes: `gitlabPlatform`, `gitlabContext` (Task 3).
- Produces (module-private in `gitlab.ts`, used again by Task 5):
  - `ciKey(module: string, key: string, value: unknown): Output` — one managed top-level key of `.gitlab-ci.yml`;
  - `NOT_SCHEDULED = '$CI_PIPELINE_SOURCE != "schedule"'`;
  - `TOOL_IMAGE = "node:24"`.

- [ ] **Step 1: Write the failing tests.** In `test/platforms-gitlab.test.ts`, extend the imports:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import { printWarnings } from "../src/commands/report.js";
import { ciModule } from "../src/modules/ci.js";
import { PACKAGE_VERSION } from "../src/version.js";
import { capture, gitlabContext, makeContext, nodeResolved, syncOnce, tempDir } from "./helpers.js";
```

(merge with the existing `node:fs/promises` and `./helpers.js` imports), add next to `files`:

```ts
const keys = (outputs: Output[]) =>
  Object.fromEntries(outputs.flatMap((o) => (o.kind === "yaml" ? [[o.keyPath.join("."), o.value]] : [])));
const NOT_SCHEDULED = [{ if: '$CI_PIPELINE_SOURCE != "schedule"' }];
```

and append:

```ts
describe("gitlab ci", () => {
  it("runs for merge requests, schedules and the default branch only", () => {
    const outputs = ciModule.outputs(gitlabContext());
    expect(outputs.every((o) => o.kind === "yaml" && o.path === ".gitlab-ci.yml" && o.module === "ci")).toBe(true);
    expect(keys(outputs).workflow).toEqual({
      rules: [
        { if: '$CI_PIPELINE_SOURCE == "merge_request_event"' },
        { if: '$CI_PIPELINE_SOURCE == "schedule"' },
        { if: '$CI_COMMIT_BRANCH == "main"' },
      ],
    });
    expect(keys(outputs).stages).toBeUndefined();
    const trunk = keys(ciModule.outputs(gitlabContext({ config: { gitlab: { default_branch: "trunk" } } })));
    expect(trunk.workflow).toMatchObject({ rules: expect.arrayContaining([{ if: '$CI_COMMIT_BRANCH == "trunk"' }]) });
  });

  it("runs the node scripts on every configured version with the npm cache", () => {
    expect(keys(ciModule.outputs(gitlabContext())).node).toEqual({
      stage: "test",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
      image: "node:${NODE_VERSION}",
      parallel: { matrix: [{ NODE_VERSION: ["22", "24"] }] },
      rules: NOT_SCHEDULED,
      variables: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_cache: "$CI_PROJECT_DIR/.npm" },
      cache: { key: { files: ["package-lock.json"] }, paths: [".npm/"] },
      script: ["npm ci", "npm run test"],
    });
  });

  it("enables corepack for pnpm and yarn and skips the npm cache", () => {
    const stack = nodeResolved({
      ci: {
        workflow: "stack-node.yml",
        with: {
          "node-versions": '["20"]',
          os: '["ubuntu-latest"]',
          "package-manager": "pnpm",
          "install-command": "pnpm install --frozen-lockfile",
          cache: "",
          scripts: '["lint","test:e2e"]',
        },
      },
    });
    const node = keys(ciModule.outputs(gitlabContext({ stacks: [stack] }))).node as Record<string, unknown>;
    expect(node.parallel).toEqual({ matrix: [{ NODE_VERSION: ["20"] }] });
    expect(node.script).toEqual([
      "corepack enable",
      "pnpm install --frozen-lockfile",
      "pnpm run lint",
      "pnpm run test:e2e",
    ]);
    expect(node.cache).toBeUndefined();
    expect(node.variables).toEqual({ COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" });
  });

  it("lints up to the source branch head, also in a merged results pipeline", () => {
    const commits = keys(ciModule.outputs(gitlabContext())).commits as { script: string[]; variables: unknown };
    expect(commits).toMatchObject({ stage: "test", image: "node:24", rules: NOT_SCHEDULED });
    expect(commits.variables).toEqual({ GIT_DEPTH: "0" });
    const script = commits.script.join("\n");
    expect(script).toContain("@commitlint/cli@21.2.3 @commitlint/config-conventional@21.2.3");
    expect(script).toContain('head="$CI_MERGE_REQUEST_SOURCE_BRANCH_SHA"');
    expect(script).toContain('[ -n "$head" ] || head="$CI_COMMIT_SHA"');
    expect(script).toContain('lint --from "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --to "$head"');
    expect(script).toContain("lint --last");
  });

  it("adds the drift job only when asked, and drops the commits job with its module", () => {
    expect(keys(ciModule.outputs(gitlabContext())).repokeeper).toBeUndefined();
    const out = keys(ciModule.outputs(gitlabContext({ modules: { drift: true, commits: false } })));
    expect(out.repokeeper).toEqual({
      stage: "test",
      image: "node:24",
      rules: NOT_SCHEDULED,
      script: [`npx --yes repokeeper@${PACKAGE_VERSION} check`],
    });
    expect(out.commits).toBeUndefined();
  });

  it("writes nothing when no job would run", () => {
    const ctx = gitlabContext({ stacks: [nodeResolved({ ci: null })], modules: { commits: false } });
    expect(ciModule.outputs(ctx)).toEqual([]);
  });

  it("keeps the user's own jobs and stays unchanged on the next sync", async () => {
    const root = await tempDir();
    await writeFile(join(root, ".gitlab-ci.yml"), "docs:\n  script:\n    - make docs\n");
    const outputs = ciModule.outputs(gitlabContext());

    await syncOnce(root, outputs);
    const written = parse(await readFile(join(root, ".gitlab-ci.yml"), "utf8"));
    expect(written.docs).toEqual({ script: ["make docs"] });
    expect(Object.keys(written)).toEqual(["workflow", "node", "commits", "docs"]);
    expect(written.node.script).toEqual(["npm ci", "npm run test"]);
    expect((await syncOnce(root, outputs)).decisions.map((d) => d.action)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
  });

  it("notes that node.os has no effect on gitlab", async () => {
    const root = await tempDir();
    const windows = nodeResolved();
    (windows.ci as { with: Record<string, string> }).with.os = '["ubuntu-latest","windows-latest"]';

    const noted = capture(root);
    await printWarnings(root, gitlabContext({ stacks: [windows] }), noted.io);
    expect(noted.out).toContain("note: node.os is ignored on gitlab (Linux runners only)");

    const quiet = capture(root);
    await printWarnings(root, gitlabContext(), quiet.io);
    await printWarnings(root, makeContext({ stacks: [windows] }), quiet.io);
    expect(quiet.out.join("\n")).not.toContain("node.os");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `npx vitest run test/platforms-gitlab.test.ts`
Expected: the `gitlab ci` tests FAIL (`ciWorkflow` returns `[]`, no note is printed); the Task 3 tests still pass.

- [ ] **Step 3: Implement the jobs.** In `src/platforms/gitlab.ts`, change the imports to:

```ts
import { defaultBranch } from "../config/types.js";
import { MANAGED_HEADER, type ModuleContext, type Output, type PlatformAdapter, type RepoInfo } from "../model.js";
import { PACKAGE_VERSION, TOOL_VERSIONS } from "../version.js";
```

add above `export const gitlabPlatform`:

```ts
const CI_FILE = ".gitlab-ci.yml";
const CI_KEYS = ["workflow", "node", "commits", "repokeeper", "renovate", "release"] as const;

/** One managed top-level key of .gitlab-ci.yml; keys the user adds are left alone. */
const ciKey = (module: string, key: string, value: unknown): Output => ({
  kind: "yaml",
  module,
  path: CI_FILE,
  keyPath: [key],
  value,
  order: CI_KEYS,
});

const NOT_SCHEDULED = '$CI_PIPELINE_SOURCE != "schedule"';
/** Image of the jobs that only run tools, whatever Node.js versions the project tests on. */
const TOOL_IMAGE = "node:24";

/** The node stack's CI inputs, as the GitHub reusable workflow receives them, as a GitLab job. */
function nodeJob(input: Record<string, string>): Record<string, unknown> {
  const pm = input["package-manager"] ?? "npm";
  const cached = input.cache === "npm";
  const scripts = JSON.parse(input.scripts ?? "[]") as string[];
  return {
    stage: "test",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
    image: "node:${NODE_VERSION}",
    parallel: { matrix: [{ NODE_VERSION: JSON.parse(input["node-versions"] ?? '["22","24"]') as string[] }] },
    rules: [{ if: NOT_SCHEDULED }],
    variables: {
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      ...(cached ? { npm_config_cache: "$CI_PROJECT_DIR/.npm" } : {}),
    },
    ...(cached ? { cache: { key: { files: ["package-lock.json"] }, paths: [".npm/"] } } : {}),
    script: [
      ...(pm === "npm" ? [] : ["corepack enable"]),
      input["install-command"] ?? "npm ci",
      ...scripts.map((script) => `${pm} run ${script}`),
    ],
  };
}

/** commitlint from a scratch directory, so the project needs no commitlint of its own. */
const COMMITLINT = `dir="$(mktemp -d)"
(cd "$dir" && echo '{ "private": true }' > package.json && npm install --no-audit --no-fund @commitlint/cli@${TOOL_VERSIONS.commitlintCli} @commitlint/config-conventional@${TOOL_VERSIONS.commitlintConventional})
cat > "$dir/commitlint.config.mjs" <<'EOF'
export default { extends: ["@commitlint/config-conventional"], rules: { "header-max-length": [2, "always", 100] } };
EOF
lint() { "$dir/node_modules/.bin/commitlint" --config "$dir/commitlint.config.mjs" --verbose "$@"; }
# a merged results pipeline runs on a merge commit; the commits to lint end at the source branch
head="$CI_MERGE_REQUEST_SOURCE_BRANCH_SHA"
[ -n "$head" ] || head="$CI_COMMIT_SHA"
if [ -n "$CI_MERGE_REQUEST_DIFF_BASE_SHA" ]; then
  lint --from "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --to "$head"
else
  lint --last
fi
`;
```

and replace `ciWorkflow: () => [],` with:

```ts
  ciWorkflow(ctx: ModuleContext): Output[] {
    const jobs: Output[] = [];
    const node = ctx.stacks.find((stack) => stack.id === "node")?.ci;
    if (node) jobs.push(ciKey("ci", "node", nodeJob(node.with)));
    if (ctx.config.modules.commits) {
      jobs.push(
        ciKey("ci", "commits", {
          stage: "test",
          image: TOOL_IMAGE,
          rules: [{ if: NOT_SCHEDULED }],
          variables: { GIT_DEPTH: "0" },
          script: [COMMITLINT],
        }),
      );
    }
    if (ctx.config.modules.drift) {
      jobs.push(
        ciKey("ci", "repokeeper", {
          stage: "test",
          image: TOOL_IMAGE,
          rules: [{ if: NOT_SCHEDULED }],
          script: [`npx --yes repokeeper@${PACKAGE_VERSION} check`],
        }),
      );
    }
    if (jobs.length === 0) return [];
    return [
      // one pipeline per merge request, per push to the default branch and per schedule; none for other branches or tags
      ciKey("ci", "workflow", {
        rules: [
          { if: '$CI_PIPELINE_SOURCE == "merge_request_event"' },
          { if: '$CI_PIPELINE_SOURCE == "schedule"' },
          { if: `$CI_COMMIT_BRANCH == "${defaultBranch(ctx.config)}"` },
        ],
      }),
      ...jobs,
    ];
  },
```

- [ ] **Step 4: Implement the note.** In `src/commands/report.ts`, in `printWarnings`, change `if (ctx.config.modules.ci) {` to `if (ctx.config.modules.ci && ctx.platform.id === "github") {` and add directly after that block's closing brace:

```ts
  if (ctx.platform.id === "gitlab") {
    const os = ctx.stacks.find((stack) => stack.id === "node")?.ci?.with.os;
    if (os !== undefined && os !== '["ubuntu-latest"]') {
      io.out("note: node.os is ignored on gitlab (Linux runners only)");
    }
  }
```

- [ ] **Step 5: Run the tests and confirm they pass.**
Run: `npm test && npx tsc --noEmit -p . && npm run lint`
Expected: all pass. If `keeps the user's own jobs` fails on the key order only, the `order` option of the `yaml` output decides it (`src/sync/yaml.ts`): managed keys in `CI_KEYS` order first, other keys after them. Fix the adapter, not the expectation.

- [ ] **Step 6: Commit.**

```bash
git add src test
git commit -m "feat(gitlab): generate the node, commits and drift jobs in .gitlab-ci.yml"
```

---

### Task 5: Releases with semantic-release, and Renovate

**Files:**
- Modify: `src/version.ts`, `src/platforms/gitlab.ts`
- Test: `test/platforms-gitlab.test.ts`

**Interfaces:**
- Consumes: `ciKey`, `NOT_SCHEDULED`, `TOOL_IMAGE` (Task 4).
- Produces: `TOOL_VERSIONS.semanticRelease`, `.semanticReleaseChangelog`, `.semanticReleaseGit`, `.semanticReleaseGitlab`, `.conventionalCommitsPreset`, `.renovate`.

- [ ] **Step 1: Write the failing tests.** In `test/platforms-gitlab.test.ts`, add the imports

```ts
import { depsModule } from "../src/modules/deps.js";
import { releaseModule } from "../src/modules/release.js";
import { planOutputs } from "../src/plan.js";
```

(check the export names with `grep -n "export const" src/modules/deps.ts src/modules/release.ts` and use the real ones), and append:

```ts
describe("gitlab release", () => {
  it("configures semantic-release for the default branch without publishing", () => {
    const outputs = releaseModule.outputs(gitlabContext({ config: { gitlab: { default_branch: "trunk" } } }));
    const config = JSON.parse(files(outputs)[".releaserc.json"] as string);
    expect(config.branches).toEqual(["trunk"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a semantic-release template
    expect(config.tagFormat).toBe("v${version}");
    expect(config.plugins).toEqual([
      ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
      ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
      ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
      ["@semantic-release/npm", { npmPublish: false }],
      [
        "@semantic-release/git",
        {
          assets: ["CHANGELOG.md", "package.json", "package-lock.json", "npm-shrinkwrap.json"],
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a semantic-release template
          message: "chore(release): ${nextRelease.version} [skip ci]",
        },
      ],
      "@semantic-release/gitlab",
    ]);
    expect(files(outputs)["release-please-config.json"]).toBeUndefined();
    expect(outputs.some((o) => o.kind === "seed" || o.kind === "marker")).toBe(false);
  });

  it("releases from the default branch only when GITLAB_TOKEN is set", () => {
    const release = keys(releaseModule.outputs(gitlabContext())).release as { script: string[] };
    expect(release).toMatchObject({
      stage: "deploy",
      image: "node:24",
      rules: [{ if: '$CI_PIPELINE_SOURCE != "schedule" && $CI_COMMIT_BRANCH == "main" && $GITLAB_TOKEN' }],
      variables: { GIT_DEPTH: "0" },
    });
    const script = release.script.join("\n");
    expect(script).toContain(
      "semantic-release@25.0.9 @semantic-release/changelog@7.0.0 @semantic-release/git@11.0.1 @semantic-release/gitlab@13.3.3 conventional-changelog-conventionalcommits@10.4.0",
    );
    expect(script).toContain('"$dir/node_modules/.bin/semantic-release"');
  });
});

describe("gitlab dependency updates", () => {
  it("configures Renovate with chore commits, one minor and patch group and no @types/node majors", () => {
    const config = JSON.parse(files(depsModule.outputs(gitlabContext()))["renovate.json"] as string);
    expect(config).toEqual({
      $schema: "https://docs.renovatebot.com/renovate-schema.json",
      extends: ["config:recommended", ":semanticCommits", ":semanticCommitTypeAll(chore)", "schedule:weekly"],
      packageRules: [
        { matchUpdateTypes: ["minor", "patch"], groupName: "minor and patch updates" },
        { matchPackageNames: ["@types/node"], matchUpdateTypes: ["major"], enabled: false },
      ],
    });
    expect(files(depsModule.outputs(gitlabContext()))[".github/dependabot.yml"]).toBeUndefined();
  });

  it("runs Renovate only in scheduled pipelines with RENOVATE_TOKEN", () => {
    expect(keys(depsModule.outputs(gitlabContext())).renovate).toEqual({
      stage: "test",
      image: "renovate/renovate:44.128.1",
      rules: [{ if: '$CI_PIPELINE_SOURCE == "schedule" && $RENOVATE_TOKEN' }],
      variables: {
        RENOVATE_PLATFORM: "gitlab",
        RENOVATE_ENDPOINT: "$CI_API_V4_URL",
        RENOVATE_AUTODISCOVER: "false",
        RENOVATE_ONBOARDING: "false",
      },
      script: ['renovate "$CI_PROJECT_PATH"'],
    });
  });
});

describe("gitlab plan", () => {
  it("release and renovate jobs stand alone when the ci module is off", () => {
    const outputs = planOutputs(gitlabContext({ modules: { ci: false } }));
    const out = keys(outputs);
    expect(Object.keys(out).sort()).toEqual(["release", "renovate"]);
    for (const job of [out.release, out.renovate] as { stage: string; rules: unknown[]; script: string[] }[]) {
      expect(["test", "deploy"]).toContain(job.stage);
      expect(job.rules.length).toBe(1);
      expect(job.script.length).toBeGreaterThan(0);
    }
  });

  it("plans every module together without two outputs for one key", () => {
    const outputs = planOutputs(gitlabContext({ modules: { drift: true } }));
    expect(Object.keys(keys(outputs)).sort()).toEqual([
      "commits",
      "node",
      "release",
      "renovate",
      "repokeeper",
      "workflow",
    ]);
    expect(outputs.some((o) => o.path.startsWith(".github/") || o.path.startsWith("release-please"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `npx vitest run test/platforms-gitlab.test.ts`
Expected: the three new describe blocks FAIL (`.releaserc.json` and `renovate.json` are undefined, no `release` or `renovate` key).

- [ ] **Step 3: Pin the tools.** In `src/version.ts`, extend `TOOL_VERSIONS`:

```ts
export const TOOL_VERSIONS = {
  lefthook: "2.1.14",
  commitlintCli: "21.2.3",
  commitlintConventional: "21.2.3",
  semanticRelease: "25.0.9",
  semanticReleaseChangelog: "7.0.0",
  semanticReleaseGit: "11.0.1",
  semanticReleaseGitlab: "13.3.3",
  conventionalCommitsPreset: "10.4.0",
  renovate: "44.128.1",
} as const;
```

- [ ] **Step 4: Implement.** In `src/platforms/gitlab.ts`, add above `export const gitlabPlatform`:

```ts
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * semantic-release and the plugins it does not bundle, from a scratch directory. It resolves plugins next to
 * itself before it looks in the project, so the project needs none of them installed.
 */
const SEMANTIC_RELEASE = `dir="$(mktemp -d)"
(cd "$dir" && echo '{ "private": true }' > package.json && npm install --no-audit --no-fund semantic-release@${TOOL_VERSIONS.semanticRelease} @semantic-release/changelog@${TOOL_VERSIONS.semanticReleaseChangelog} @semantic-release/git@${TOOL_VERSIONS.semanticReleaseGit} @semantic-release/gitlab@${TOOL_VERSIONS.semanticReleaseGitlab} conventional-changelog-conventionalcommits@${TOOL_VERSIONS.conventionalCommitsPreset})
"$dir/node_modules/.bin/semantic-release"
`;
```

replace `dependencyUpdates: () => [],` with:

```ts
  // Renovate finds the package managers itself, so the Dependabot ecosystem names are not needed
  dependencyUpdates(): Output[] {
    return [
      {
        kind: "file",
        module: "deps",
        path: "renovate.json",
        content: json({
          $schema: "https://docs.renovatebot.com/renovate-schema.json",
          // chore commits pass commitlint, as the Dependabot prefix does on GitHub
          extends: ["config:recommended", ":semanticCommits", ":semanticCommitTypeAll(chore)", "schedule:weekly"],
          packageRules: [
            { matchUpdateTypes: ["minor", "patch"], groupName: "minor and patch updates" },
            // @types/node majors track the Node.js line a project runs on, which the project chooses
            { matchPackageNames: ["@types/node"], matchUpdateTypes: ["major"], enabled: false },
          ],
        }),
      },
      // runs from a pipeline schedule of the repository; without the token or a schedule it never starts
      ciKey("deps", "renovate", {
        stage: "test",
        image: `renovate/renovate:${TOOL_VERSIONS.renovate}`,
        rules: [{ if: '$CI_PIPELINE_SOURCE == "schedule" && $RENOVATE_TOKEN' }],
        variables: {
          RENOVATE_PLATFORM: "gitlab",
          RENOVATE_ENDPOINT: "$CI_API_V4_URL",
          RENOVATE_AUTODISCOVER: "false",
          RENOVATE_ONBOARDING: "false",
        },
        script: ['renovate "$CI_PROJECT_PATH"'],
      }),
    ];
  },
```

and replace `releaseAutomation: () => [],` with:

```ts
  releaseAutomation(ctx: ModuleContext): Output[] {
    const branch = defaultBranch(ctx.config);
    return [
      {
        kind: "file",
        module: "release",
        path: ".releaserc.json",
        content: json({
          branches: [branch],
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a semantic-release template
          tagFormat: "v${version}",
          plugins: [
            ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
            ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
            ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
            // bumps package.json and the npm lock file; publishing stays the project's own business
            ["@semantic-release/npm", { npmPublish: false }],
            [
              "@semantic-release/git",
              {
                assets: ["CHANGELOG.md", "package.json", "package-lock.json", "npm-shrinkwrap.json"],
                // biome-ignore lint/suspicious/noTemplateCurlyInString: a semantic-release template
                message: "chore(release): ${nextRelease.version} [skip ci]",
              },
            ],
            "@semantic-release/gitlab",
          ],
        }),
      },
      // semantic-release pushes a commit and a tag, which the job token cannot do; without GITLAB_TOKEN the job is absent
      ciKey("release", "release", {
        stage: "deploy",
        image: TOOL_IMAGE,
        rules: [{ if: `${NOT_SCHEDULED} && $CI_COMMIT_BRANCH == "${branch}" && $GITLAB_TOKEN` }],
        variables: { GIT_DEPTH: "0" },
        script: [SEMANTIC_RELEASE],
      }),
    ];
  },
```

- [ ] **Step 5: Run the tests and confirm they pass.**
Run: `npm test && npx tsc --noEmit -p . && npm run lint`
Expected: all pass.

- [ ] **Step 6: Commit.**

```bash
git add src test
git commit -m "feat(gitlab): release with semantic-release and update dependencies with Renovate"
```

---

### Task 6: `init --platform`, the `github apply` guard, end to end, README

**Files:**
- Modify: `src/cli.ts`, `src/commands/report.ts` (`CommandOptions`), `src/commands/init.ts`, `src/commands/github.ts`, `README.md`
- Test: `test/e2e-gitlab.test.ts` (create)

**Interfaces:**
- Consumes: `remoteHost`, `repoInfo(root, platform)`, `platformFor`, `defaultConfig({ platform })`.
- Produces: `CommandOptions.platform?: PlatformId`; the CLI option `--platform <github|gitlab>`.

- [ ] **Step 1: Write the failing tests** in `test/e2e-gitlab.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { run } from "../src/cli.js";
import { capture, tempDir } from "./helpers.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

async function nodeRepo(remote: string | null, branch = "main"): Promise<string> {
  const dir = await tempDir();
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "demo", version: "0.1.0", scripts: { test: "vitest run" } }, null, 2)}\n`,
  );
  sh(dir, "init", "-q", "-b", branch);
  sh(dir, "config", "user.name", "Demo User");
  sh(dir, "config", "user.email", "demo@example.com");
  sh(dir, "config", "core.autocrlf", "false");
  if (remote) sh(dir, "remote", "add", "origin", remote);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "chore: initial");
  return dir;
}

async function repokeeper(dir: string, ...args: string[]) {
  const c = capture(dir);
  const code = await run(args, c.io);
  return { code, out: c.out.join("\n"), err: c.err.join("\n") };
}

const read = (dir: string, path: string) => readFile(join(dir, path), "utf8");

describe("repokeeper on gitlab, end to end", () => {
  it("detects gitlab from the remote, writes the gitlab standard and checks clean", async () => {
    const dir = await nodeRepo("https://gitlab.com/acme/tools/demo.git");
    const init = await repokeeper(dir, "init");
    expect(init.err).toBe("");
    expect(init.code).toBe(0);

    const config = parse(await read(dir, ".repokeeper.yml"));
    expect(config.platform).toBe("gitlab");
    expect(config.modules.health.contact).toBe("https://gitlab.com/acme/tools");
    expect(config.modules.health.codeowners).toEqual(["@acme/tools"]);
    expect(config.github).toBeUndefined();

    for (const path of [
      ".gitlab-ci.yml",
      ".releaserc.json",
      "renovate.json",
      ".gitlab/CODEOWNERS",
      ".gitlab/issue_templates/Bug.md",
      ".gitlab/merge_request_templates/Default.md",
    ]) {
      expect(existsSync(join(dir, path)), path).toBe(true);
    }
    for (const path of [".github", "release-please-config.json", ".release-please-manifest.json"]) {
      expect(existsSync(join(dir, path)), path).toBe(false);
    }
    const ci = parse(await read(dir, ".gitlab-ci.yml"));
    expect(Object.keys(ci)).toEqual(["workflow", "node", "commits", "renovate", "release"]);
    expect(ci.node.script).toEqual(["npm install", "npm run test"]);
    expect(await read(dir, "SECURITY.md")).toContain("https://gitlab.com/acme/tools/demo/-/issues/new");

    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: sync");
    expect((await repokeeper(dir, "check")).code).toBe(0);
  });

  it("takes --platform over the remote and stores a default branch other than main under gitlab", async () => {
    const dir = await nodeRepo(null, "trunk");
    sh(dir, "remote", "add", "origin", dir);
    sh(dir, "fetch", "-q", "origin");
    sh(dir, "remote", "set-head", "origin", "trunk");

    expect((await repokeeper(dir, "init", "--platform", "gitlab")).code).toBe(0);
    const config = parse(await read(dir, ".repokeeper.yml"));
    expect(config.platform).toBe("gitlab");
    expect(config.gitlab).toEqual({ default_branch: "trunk" });
    expect(config.modules.health.contact).toBe("the repository maintainers");
    expect(JSON.parse(await read(dir, ".releaserc.json")).branches).toEqual(["trunk"]);
  });

  it("stays on github for a GitHub remote and for no remote", async () => {
    for (const remote of ["https://github.com/demo-owner/demo.git", null]) {
      const dir = await nodeRepo(remote);
      expect((await repokeeper(dir, "init")).code).toBe(0);
      expect(parse(await read(dir, ".repokeeper.yml")).platform).toBe("github");
      expect(existsSync(join(dir, ".gitlab-ci.yml"))).toBe(false);
    }
  });

  it("refuses an unsupported stack before writing anything", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
    sh(dir, "init", "-q", "-b", "main");
    const init = await repokeeper(dir, "init", "--platform", "gitlab");
    expect(init.code).toBe(2);
    expect(init.err).toContain('stack "python" is not supported on gitlab yet (supported: node)');
    expect(existsSync(join(dir, ".repokeeper.yml"))).toBe(false);
  });

  it("rejects --platform with an unknown value or outside init", async () => {
    const dir = await nodeRepo(null);
    const unknown = await repokeeper(dir, "init", "--platform", "bitbucket");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown platform bitbucket; expected github or gitlab");
    const check = await repokeeper(dir, "check", "--platform", "gitlab");
    expect(check.code).toBe(2);
    expect(check.err).toContain("--platform is only for init");
  });

  it("refuses github apply on a gitlab repository", async () => {
    const dir = await nodeRepo("https://gitlab.com/acme/demo.git");
    expect((await repokeeper(dir, "init")).code).toBe(0);
    const apply = await repokeeper(dir, "github", "apply", "--dry-run");
    expect(apply.code).toBe(2);
    expect(apply.err).toContain("this repository uses the gitlab platform");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `npx vitest run test/e2e-gitlab.test.ts`
Expected: FAIL — `--platform` is an unknown option, and `init` writes `platform: github` for a GitLab remote.

- [ ] **Step 3: Implement the CLI option.**

`src/commands/report.ts`, in `CommandOptions`, after `yes: boolean;`:

```ts
  /** Platform to use instead of detection from the origin remote (init). */
  platform?: import("../config/types.js").PlatformId;
```

`src/cli.ts`:

- In `USAGE`, after the `--stack` line:

```ts
  "  --platform <id>  github or gitlab, instead of detection from the origin remote (init)",
```

- In the `parseArgs` options, after `stack`:

```ts
        platform: { type: "string" },
```

- After the loop that validates stacks:

```ts
    const platform = values.platform as string | undefined;
    if (platform !== undefined && platform !== "github" && platform !== "gitlab") {
      throw new UsageError(`unknown platform ${platform}; expected github or gitlab`);
    }
    if (platform !== undefined && command !== "init") throw new UsageError("--platform is only for init");
```

- In the `options` object, after `yes: values.yes as boolean,`:

```ts
      ...(platform !== undefined ? { platform } : {}),
```

- [ ] **Step 4: Implement platform selection in `init`.** In `src/commands/init.ts`:

- Change the git import to `import { dirtyPaths, gitUserName, remoteDefaultBranch, remoteHost, repoInfo } from "../git.js";` and add `import { platformFor } from "../platforms/index.js";`.
- Replace the statements from `const repo = await repoInfo(root);` through `if (branch && branch !== "main") config.github = { default_branch: branch };` with:

```ts
  const platform = options.platform ?? ((await remoteHost(root))?.includes("gitlab") ? "gitlab" : "github");
  const repo = await repoInfo(root, platform);
  const holder = (await gitUserName(root)) ?? repo.owner ?? "the project authors";
  const config = defaultConfig({
    stacks,
    standard: STANDARD_VERSION,
    copyright: `${new Date().getFullYear()} ${holder}`,
    contact: platformFor(platform).profileUrl(repo) ?? "the repository maintainers",
    codeowners: repo.owner ? [`@${repo.owner}`] : [],
    platform,
  });
  const branch = await remoteDefaultBranch(root);
  if (branch && branch !== "main") config[platform] = { default_branch: branch };
```

`src/commands/github.ts`, directly after `const config = await loadConfig(root);`:

```ts
  if (config.platform !== "github") throw new UsageError(`this repository uses the ${config.platform} platform`);
```

- [ ] **Step 5: Run the tests and confirm they pass.**
Run: `npm test && npx tsc --noEmit -p . && npm run lint`
Expected: all pass, including the existing `test/e2e.test.ts` and `test/cli.test.ts` unchanged.

If the first e2e test fails on `ci.node.script`, read the node stack (`src/stacks/node.ts`): without a lock file the install command is `npm install`; the expectation follows the stack, do not special-case the adapter.

- [ ] **Step 6: README.** In `README.md`:

- In the intro sentence that lists what repokeeper covers (line 9, "plus GitHub settings through `repokeeper github apply`"), add after it: ` GitLab is supported for Node.js projects.`
- Add this section directly before `## Pilots`:

````markdown
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

Two jobs stay inactive until you set them up in the project's CI/CD settings:

- **`release`** needs a CI/CD variable `GITLAB_TOKEN`: a project access token with the `api` and
  `write_repository` scopes and a role that may push to the default branch. Every push to the
  default branch with a `feat`, `fix` or breaking change then releases at once: version bump,
  `CHANGELOG.md`, tag and GitLab release. There is no release merge request. A repository without
  a `vX.Y.Z` tag starts at `1.0.0`; tag the current version first to continue from it.
- **`renovate`** needs a CI/CD variable `RENOVATE_TOKEN` (same scopes) and a pipeline schedule,
  for example weekly.

`repokeeper github apply` has no GitLab counterpart yet.
````

- [ ] **Step 7: Verify the build and this repository's own standard.**
Run: `npm run build && node dist/cli.js check`
Expected: `repository matches the standard` (repokeeper itself is a GitHub repository and its output did not change).

- [ ] **Step 8: Commit.**

```bash
git add src test README.md
git commit -m "feat(init): select the gitlab platform from the remote or --platform"
```

---

## After the plan

Release `0.5.0` goes out through the usual release pull request. The pilot from the spec (a demo node repository on gitlab.com: green merge request pipeline, one real release, one Renovate merge request) needs the user's gitlab.com account and tokens, and is where the generated pipeline is first validated by GitLab itself.
