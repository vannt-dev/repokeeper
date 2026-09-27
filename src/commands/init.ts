import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Io } from "../cli.js";
import { CONFIG_FILE, loadConfig, renderConfig } from "../config/load.js";
import { defaultConfig } from "../config/types.js";
import { UsageError } from "../errors.js";
import { dirtyPaths, gitUserName, remoteDefaultBranch, repoInfo } from "../git.js";
import { outputId } from "../model.js";
import { planOutputs } from "../plan.js";
import { detectStacks } from "../stacks/index.js";
import { applySync } from "../sync/apply.js";
import { hashText } from "../sync/hash.js";
import { type Lock, targetOf, writeLock } from "../sync/lock.js";
import { readCurrent } from "../sync/state.js";
import { computeSync, pathsToWrite, type SyncResult } from "../sync/sync.js";
import { STANDARD_VERSION } from "../version.js";
import { buildContext } from "./context.js";
import { type CommandOptions, printResult } from "./report.js";

export async function guardUncommitted(root: string, result: SyncResult, force: boolean): Promise<void> {
  if (force) return;
  const dirty = await dirtyPaths(root, pathsToWrite(result));
  if (dirty.length === 0) return;
  const names = dirty.map((d) => (d.untracked ? `${d.path} (untracked)` : d.path)).join(", ");
  const hint = dirty.some((d) => d.untracked)
    ? "; untracked files are protected too, so commit them first (git add -A && git commit), or pass --force"
    : "; commit or stash them, or pass --force";
  throw new UsageError(`uncommitted changes in ${names}${hint}`);
}

export async function initCommand(root: string, options: CommandOptions, io: Io): Promise<number> {
  if (options.relock) return relock(root, options, io);
  if (existsSync(join(root, CONFIG_FILE))) {
    throw new UsageError(`${CONFIG_FILE} already exists; run \`repokeeper update\` or \`repokeeper check\``);
  }
  const stacks = options.stacks.length > 0 ? options.stacks : await detectStacks(root);
  if (stacks.length === 0) throw new UsageError("no supported stack detected; pass --stack node");

  const repo = await repoInfo(root);
  const holder = (await gitUserName(root)) ?? repo.owner ?? "the project authors";
  const config = defaultConfig({
    stacks,
    standard: STANDARD_VERSION,
    copyright: `${new Date().getFullYear()} ${holder}`,
    contact: repo.owner ? `https://github.com/${repo.owner}` : "the repository maintainers",
    codeowners: repo.owner ? [`@${repo.owner}`] : [],
  });
  const branch = await remoteDefaultBranch(root);
  if (branch && branch !== "main") config.github = { default_branch: branch };
  const ctx = await buildContext(root, config, repo);
  const adopt = options.adoptAll ? ("all" as const) : new Set(options.adopt);
  const result = await computeSync(root, planOutputs(ctx), null, { adopt, accept: new Set() });
  if (!options.dryRun) await guardUncommitted(root, result, options.force);
  printResult(io, result);
  if (options.dryRun) {
    io.out("dry run: nothing written");
    return 0;
  }
  await writeFile(join(root, CONFIG_FILE), renderConfig(config));
  await applySync(root, result, null, STANDARD_VERSION);
  io.out(`applied standard ${STANDARD_VERSION}; wrote ${CONFIG_FILE}`);
  io.out(
    `next: install dependencies (this installs the git hooks), then commit with "chore(repokeeper): apply standard ${STANDARD_VERSION}"`,
  );
  return 0;
}

/** Records the current content of every planned output as repokeeper's own, rebuilding a lost or corrupt lock. */
async function relock(root: string, options: CommandOptions, io: Io): Promise<number> {
  const config = await loadConfig(root);
  const ctx = await buildContext(root, config);
  const lock: Lock = { lockVersion: 1, standard: config.standard, entries: [] };
  for (const output of planOutputs(ctx)) {
    const current = await readCurrent(root, targetOf(output));
    if (current === null) continue;
    lock.entries.push({
      id: outputId(output),
      module: output.module,
      hash: hashText(current),
      target: targetOf(output),
    });
    io.out(`recorded   ${output.path}`);
  }
  if (options.dryRun) {
    io.out("dry run: nothing written");
    return 0;
  }
  await writeLock(root, lock);
  io.out(`rebuilt .repokeeper/lock.json with ${lock.entries.length} entries`);
  return 0;
}
