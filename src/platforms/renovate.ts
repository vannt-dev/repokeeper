import type { Output } from "../model.js";

/** One entry of Renovate's `packageRules`. */
export type PackageRule = Record<string, unknown>;

/** Presets every renovate.json starts from, before the repository's own `modules.deps.extends`. */
export const RENOVATE_PRESETS = ["config:recommended", ":semanticCommits", ":semanticCommitTypeAll(chore)"] as const;

/**
 * renovate.json, the same on both platforms apart from `managed`: the rule that keeps Renovate away from
 * the versions repokeeper's own files name, which the standard moves with `repokeeper update`.
 */
export function renovateJson(options: { presets: string[]; managed: PackageRule[]; automerge: boolean }): Output {
  const config = {
    $schema: "https://docs.renovatebot.com/renovate-schema.json",
    // chore commits pass commitlint, as the Dependabot prefix does. No schedule preset: on GitLab the
    // pipeline schedule sets the cadence, and a Renovate schedule would skip runs outside its own window
    extends: [...RENOVATE_PRESETS, ...options.presets],
    packageRules: [
      {
        matchUpdateTypes: ["minor", "patch"],
        groupName: "minor and patch updates",
        // Renovate's own auto-merge; a major is never in the group, so it stays manual
        ...(options.automerge ? { automerge: true } : {}),
      },
      // @types/node majors track the Node.js line a project runs on, which the project chooses
      { matchPackageNames: ["@types/node"], matchUpdateTypes: ["major"], enabled: false },
      ...options.managed,
    ],
  };
  return { kind: "file", module: "deps", path: "renovate.json", content: `${JSON.stringify(config, null, 2)}\n` };
}
