import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE } from "../config/load.js";
import type { RepokeeperConfig } from "../config/types.js";
import { ConfigError, UsageError } from "../errors.js";
import { repoInfo } from "../git.js";
import type { ModuleContext, RepoInfo } from "../model.js";
import { platformFor } from "../platforms/index.js";
import { getStackPack } from "../stacks/index.js";
import { stackDirectory } from "../stacks/support.js";

export async function buildContext(root: string, config: RepokeeperConfig, repo?: RepoInfo): Promise<ModuleContext> {
  const platform = platformFor(config.platform);
  const unsupported = config.stacks.find((id) => !platform.stacks.includes(id));
  if (unsupported) {
    throw new UsageError(
      `stack "${unsupported}" is not supported on ${platform.id} yet (supported: ${platform.stacks.join(", ")})`,
    );
  }
  const stacks = await Promise.all(
    config.stacks.map(async (id) => {
      // `directory` is read here, for every stack alike; the rest of the options are the stack's own
      const { directory: _directory, ...options } = config.stack_options[id] ?? {};
      const directory = stackDirectory(id, config.stack_options[id] ?? {});
      if (directory === undefined) return getStackPack(id).resolve(root, options);
      if (platform.id !== "github") {
        throw new UsageError(
          `a stack in a folder of its own (stack_options.${id}.directory) is not supported on ${platform.id} yet`,
        );
      }
      if (!existsSync(join(root, directory))) {
        throw new ConfigError(`${CONFIG_FILE}: stack_options.${id}.directory: the folder ${directory} does not exist`);
      }
      return { ...(await getStackPack(id).resolve(join(root, directory), options)), directory };
    }),
  );
  return { config, stacks, platform, repo: repo ?? (await repoInfo(root, config.platform)) };
}
