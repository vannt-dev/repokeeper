import type { Io } from "../cli.js";
import type { HealthConfig, ModulesConfig, RepokeeperConfig } from "../config/types.js";
import type { ModuleContext, Output } from "../model.js";

export const PRESETS = ["essential", "standard", "strict"] as const;
export type Preset = (typeof PRESETS)[number];

/** One line per preset, for the usage text and the interactive question. */
export const PRESET_SUMMARY: Record<Preset, string> = {
  essential: "editor settings, .gitignore and CI only",
  standard: "everything except the drift check (the default)",
  strict: "everything, the drift check, and branch protection with a required review",
};

type ModuleId = keyof ModulesConfig;
/** The order the modules are offered in: files first, then the automation built on them. */
export const MODULE_IDS: ModuleId[] = [
  "editorconfig",
  "gitignore",
  "commits",
  "hooks",
  "ci",
  "release",
  "deps",
  "health",
  "drift",
];

/**
 * Applies a preset to a freshly built default configuration.
 *
 * A preset only switches on what repokeeper really does. There is no tier that promises code or
 * secret scanning, because no module writes it.
 */
export function applyPreset(config: RepokeeperConfig, preset: Preset): RepokeeperConfig {
  if (preset === "standard") return config;
  if (preset === "essential") {
    return {
      ...config,
      modules: {
        ...config.modules,
        commits: false,
        hooks: false,
        release: false,
        deps: false,
        drift: false,
        health: false,
      },
    };
  }
  const strict: RepokeeperConfig = { ...config, modules: { ...config.modules, drift: true } };
  // repository settings exist on GitHub only; they take effect with `repokeeper github apply`
  if (config.platform === "github") {
    strict.github = {
      ...config.github,
      security: { dependabot_alerts: true, dependabot_security_updates: true },
      protect: {
        require_pull_request: true,
        required_approvals: 1,
        allow_force_push: false,
        ...(config.modules.commits ? { required_checks: ["commits / commitlint"] } : {}),
      },
    };
  }
  return strict;
}

/** The files each module would write to, so a question about it can name them. */
function filesByModule(outputs: Output[]): Map<string, string[]> {
  const files = new Map<string, Set<string>>();
  for (const output of outputs) {
    // one line per file, however many of its keys or blocks the module manages
    files.set(output.module, (files.get(output.module) ?? new Set()).add(output.path));
  }
  return new Map([...files].map(([module, paths]) => [module, [...paths].sort()]));
}

/** The drift check is a job of the CI workflow, planned by the ci module. */
const plannedBy = (module: ModuleId) => (module === "drift" ? "ci" : module);

/**
 * Asks, module by module, whether to apply it, naming the files it would write. The answer that
 * Enter gives is the preset's.
 *
 * @param plan Plans the outputs for a configuration; called with every module switched on, so that
 *   a module the preset leaves out can still say what it would add.
 */
export async function chooseModules(
  config: RepokeeperConfig,
  health: HealthConfig,
  plan: (config: RepokeeperConfig) => Promise<{ ctx: ModuleContext; outputs: Output[] }>,
  io: Io & { confirm: NonNullable<Io["confirm"]> },
): Promise<RepokeeperConfig> {
  const everything: RepokeeperConfig = {
    ...config,
    modules: {
      editorconfig: true,
      commits: true,
      hooks: true,
      ci: true,
      release: true,
      deps: true,
      gitignore: true,
      drift: true,
      health,
    },
  };
  const files = filesByModule((await plan(everything)).outputs);
  const modules = { ...config.modules };
  io.out("Choose what to apply. Enter keeps the answer in capitals.");
  for (const id of MODULE_IDS) {
    const listed =
      id === "drift"
        ? [".github/workflows/ci.yml (a job that fails a pull request when a managed file was edited by hand)"]
        : (files.get(plannedBy(id)) ?? []);
    if (listed.length === 0) continue;
    const shown = listed.length > 6 ? [...listed.slice(0, 6), `and ${listed.length - 6} more`] : listed;
    io.out("");
    io.out(`${id}:`);
    for (const file of shown) io.out(`  ${file}`);
    const wanted = await io.confirm(`Apply ${id}?`, Boolean(modules[id]));
    if (id === "health") modules.health = wanted ? health : false;
    else modules[id] = wanted;
  }
  io.out("");
  return { ...config, modules };
}
