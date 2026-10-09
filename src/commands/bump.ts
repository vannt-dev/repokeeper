import { join } from "node:path";
import type { Io } from "../cli.js";
import { loadConfig } from "../config/load.js";
import { UsageError } from "../errors.js";
import { pickReleaseStack } from "../modules/release.js";
import { bumpVersion } from "../release/bump.js";
import { buildContext } from "./context.js";
import type { CommandOptions } from "./report.js";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * `repokeeper bump <version>`: writes a release's version into the version files of the stack the
 * repository releases. The GitLab release job runs it, where no release tool knows the stack's files.
 */
export async function bumpCommand(
  root: string,
  version: string | undefined,
  options: CommandOptions,
  io: Io,
): Promise<number> {
  if (version === undefined || !VERSION.test(version)) {
    throw new UsageError("usage: repokeeper bump <version> [--dry-run], with a version such as 1.4.0");
  }
  const ctx = await buildContext(root, await loadConfig(root));
  const stack = pickReleaseStack(ctx.stacks);
  if (stack === undefined) throw new UsageError("no stack to release");
  const folder = stack.directory ? join(root, stack.directory) : root;
  const changed = await bumpVersion(folder, stack.release, version, !options.dryRun);
  for (const path of changed) io.out(`bumped     ${stack.directory ? `${stack.directory}/${path}` : path}`);
  if (changed.length === 0) {
    io.out(`no file of the ${stack.id} stack holds a version to change; the release is its tag`);
  }
  if (options.dryRun) io.out("dry run: nothing written");
  return 0;
}
