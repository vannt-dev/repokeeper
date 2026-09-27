import type { GithubSettings } from "../github/settings.js";
export const STACK_IDS = ["node", "python", "dart", "script", "java", "dotnet", "go", "rust", "kotlin"] as const;
export type StackId = (typeof STACK_IDS)[number];

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
  health: HealthConfig | false;
}

export interface RepokeeperConfig {
  schema: 1;
  standard: string;
  platform: "github";
  stacks: StackId[];
  modules: ModulesConfig;
  owned: string[];
  stack_options: Record<string, Record<string, unknown>>;
  github?: GithubSettings;
}

/** The branch workflows run on and contributors branch from: `github.default_branch`, or `main`. */
export function defaultBranch(config: RepokeeperConfig): string {
  const branch = config.github?.default_branch;
  return typeof branch === "string" && branch.length > 0 ? branch : "main";
}

export function defaultConfig(input: {
  stacks: StackId[];
  standard: string;
  copyright: string;
  contact: string;
  codeowners: string[];
}): RepokeeperConfig {
  return {
    schema: 1,
    standard: input.standard,
    platform: "github",
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
      health: { license: "MIT", copyright: input.copyright, contact: input.contact, codeowners: input.codeowners },
    },
    owned: [],
    stack_options: {},
  };
}
