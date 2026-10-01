import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../src/cli.js";
import { defaultConfig, type ModulesConfig, type RepokeeperConfig } from "../src/config/types.js";
import type { ModuleContext, Output, RepoInfo, ResolvedStack } from "../src/model.js";
import { githubPlatform } from "../src/platforms/github.js";
import { gitlabPlatform } from "../src/platforms/gitlab.js";
import { applySync } from "../src/sync/apply.js";
import { readLock } from "../src/sync/lock.js";
import { computeSync, type SyncResult } from "../src/sync/sync.js";

export function capture(cwd: string = process.cwd()): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { cwd, out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

export function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "repokeeper-"));
}

export function nodeResolved(overrides: Partial<ResolvedStack> = {}): ResolvedStack {
  return {
    id: "node",
    staged: [{ name: "node:prettier", glob: "*.{js,ts}", run: "npx prettier --write --ignore-unknown {staged_files}" }],
    test: "npm test",
    install: "npm install",
    gitignore: ["Node"],
    dependabot: ["npm"],
    ci: {
      workflow: "stack-node.yml",
      with: {
        "node-versions": '["22","24"]',
        os: '["ubuntu-latest"]',
        "package-manager": "npm",
        "install-command": "npm ci",
        cache: "npm",
        scripts: '["test"]',
      },
    },
    release: { type: "node", version: "1.0.0" },
    ...overrides,
  };
}

export function makeContext(
  overrides: {
    config?: Partial<RepokeeperConfig>;
    modules?: Partial<ModulesConfig>;
    stacks?: ResolvedStack[];
    repo?: RepoInfo;
  } = {},
): ModuleContext {
  const base = defaultConfig({
    stacks: ["node"],
    standard: "1.0.0",
    copyright: "2026 Van Nguyen",
    contact: "https://github.com/vannt-dev",
    codeowners: ["@vannt-dev"],
  });
  const config: RepokeeperConfig = { ...base, ...overrides.config, modules: { ...base.modules, ...overrides.modules } };
  return {
    config,
    stacks: overrides.stacks ?? [nodeResolved()],
    platform: githubPlatform,
    repo: overrides.repo ?? { owner: "vannt-dev", name: "example" },
  };
}

/** `makeContext` for a repository on GitLab. */
export function gitlabContext(overrides: Parameters<typeof makeContext>[0] = {}): ModuleContext {
  const ctx = makeContext({
    ...overrides,
    config: { platform: "gitlab", ...overrides.config },
    repo: overrides.repo ?? { host: "gitlab.com", owner: "acme/tools", name: "example" },
  });
  return { ...ctx, platform: gitlabPlatform };
}

/** Plans nothing: computes and applies one sync of `outputs`, as `update` would. */
export async function syncOnce(root: string, outputs: Output[], standard = "1.1.0"): Promise<SyncResult> {
  const lock = await readLock(root);
  const result = await computeSync(root, outputs, lock, { adopt: new Set(), accept: new Set() });
  await applySync(root, result, lock, standard);
  return result;
}
