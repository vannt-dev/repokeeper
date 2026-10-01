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
