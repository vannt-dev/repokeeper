import type { GithubSettings } from "../github/settings.js";
import type { GitlabSettings } from "../gitlab/settings.js";
export const STACK_IDS = [
  "node",
  "python",
  "dart",
  "script",
  "java",
  "dotnet",
  "go",
  "rust",
  "kotlin",
  "php",
  "ruby",
  "docker",
] as const;
export type StackId = (typeof STACK_IDS)[number];
export type PlatformId = "github" | "gitlab";

export interface HealthConfig {
  /** SPDX id, or false to leave licensing alone. v1 bundles MIT only. */
  license: string | false;
  /** LICENSE holder line, e.g. "2026 Van Nguyen". */
  copyright: string;
  /** Code of Conduct contact: a URL or an e-mail address. */
  contact: string;
  codeowners: string[];
}

export interface ModulesConfig {
  editorconfig: boolean;
  commits: boolean;
  hooks: boolean;
  ci: boolean;
  release: boolean;
  deps: boolean;
  gitignore: boolean;
  /** A ci job that runs `repokeeper check`; off unless asked for. */
  drift: boolean;
  /** A scheduled workflow that opens a pull request when the standard has moved; off unless asked for. */
  autoupdate: boolean;
  /** A workflow that runs code scanning (CodeQL) on pull requests, pushes and weekly; off unless asked for. */
  security: boolean;
  /** A workflow that deletes the Actions caches nothing will read again; off unless asked for. */
  cache_cleanup: boolean;
  /** A workflow that turns on auto-merge for Dependabot's patch and minor updates; off unless asked for. */
  automerge: boolean;
  /** A job in the release workflow that publishes each release to npm or PyPI; off unless asked for. */
  publish: boolean;
  /** A workflow that checks the GitHub Actions workflows with actionlint and zizmor; off unless asked for. */
  workflow_lint: boolean;
  health: HealthConfig | false;
}

export interface RepokeeperConfig {
  schema: 1;
  standard: string;
  platform: PlatformId;
  stacks: StackId[];
  modules: ModulesConfig;
  owned: string[];
  stack_options: Record<string, Record<string, unknown>>;
  github?: GithubSettings;
  gitlab?: GitlabSettings;
}

/** The branch CI runs on and contributors branch from: `default_branch` of the configured platform, or `main`. */
export function defaultBranch(config: RepokeeperConfig): string {
  const branch = (config.platform === "gitlab" ? config.gitlab : config.github)?.default_branch;
  return typeof branch === "string" && branch.length > 0 ? branch : "main";
}

export function defaultConfig(input: {
  stacks: StackId[];
  standard: string;
  copyright: string;
  contact: string;
  codeowners: string[];
  platform?: PlatformId;
}): RepokeeperConfig {
  return {
    schema: 1,
    standard: input.standard,
    platform: input.platform ?? "github",
    stacks: input.stacks,
    modules: {
      editorconfig: true,
      commits: true,
      hooks: true,
      ci: true,
      release: true,
      deps: true,
      gitignore: true,
      drift: false,
      autoupdate: false,
      security: false,
      cache_cleanup: false,
      automerge: false,
      publish: false,
      workflow_lint: false,
      health: { license: "MIT", copyright: input.copyright, contact: input.contact, codeowners: input.codeowners },
    },
    owned: [],
    stack_options: {},
  };
}
