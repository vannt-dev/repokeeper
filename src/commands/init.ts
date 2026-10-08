import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Io } from "../cli.js";
import { CONFIG_FILE, loadConfig, renderConfig } from "../config/load.js";
import { defaultConfig, type RepokeeperConfig } from "../config/types.js";
import { UsageError } from "../errors.js";
import { dirtyPaths, gitUserName, remoteDefaultBranch, remoteHost, repoInfo } from "../git.js";
import { outputId } from "../model.js";
import { planOutputs } from "../plan.js";
import { platformFor } from "../platforms/index.js";
import { detectStackLayout } from "../stacks/index.js";
import { applySync } from "../sync/apply.js";
import { hashText } from "../sync/hash.js";
import { type Lock, targetOf, writeLock } from "../sync/lock.js";
import { readCurrent } from "../sync/state.js";
import { computeSync, pathsToWrite, type SyncResult } from "../sync/sync.js";
import { STANDARD_VERSION } from "../version.js";
import { buildContext } from "./context.js";
import { applyPreset, chooseModules } from "./presets.js";
import { type CommandOptions, nextSteps, printResult, printWarnings } from "./report.js";

/** A dirty path is still safe to write when every part repokeeper manages in it is exactly what it last wrote. */
async function onlyRepokeeperChanges(root: string, path: string, lock: Lock | null): Promise<boolean> {
  const entries = lock?.entries.filter((e) => e.target.path === path) ?? [];
  if (entries.length === 0) return false;
  for (const entry of entries) {
    const current = await readCurrent(root, entry.target);
    if (current === null || hashText(current) !== entry.hash) return false;
  }
  return true;
}

export async function guardUncommitted(
  root: string,
  result: SyncResult,
  force: boolean,
  lock: Lock | null = null,
): Promise<void> {
  if (force) return;
  const dirty = [];
  for (const d of await dirtyPaths(root, pathsToWrite(result))) {
    if (!(await onlyRepokeeperChanges(root, d.path, lock))) dirty.push(d);
  }
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
  const layout =
    options.stacks.length > 0
      ? { stacks: options.stacks, directories: options.stackDirectories ?? {}, skipped: [] }
      : await detectStackLayout(root);
  const { stacks } = layout;
  if (stacks.length === 0) throw new UsageError("no supported stack detected; pass --stack node");
  for (const id of stacks) {
    if (layout.directories[id] !== undefined) io.out(`found ${id} in ${layout.directories[id]}/`);
  }
  for (const { stack, directory } of layout.skipped) {
    io.out(`note: ${directory}/ also holds a ${stack} project; one folder per stack is managed, so it is left out`);
  }

  const platform = options.platform ?? ((await remoteHost(root))?.includes("gitlab") ? "gitlab" : "github");
  const repo = await repoInfo(root, platform);
  const holder = (await gitUserName(root)) ?? repo.owner ?? "the project authors";
  const { confirm } = io;
  if (options.interactive && confirm === undefined) {
    throw new UsageError("--interactive needs a terminal to ask its questions in");
  }
  const defaults = defaultConfig({
    stacks,
    standard: STANDARD_VERSION,
    copyright: `${new Date().getFullYear()} ${holder}`,
    contact: platformFor(platform).profileUrl(repo) ?? "the repository maintainers",
    codeowners: repo.owner ? [`@${repo.owner}`] : [],
    platform,
  });
  for (const id of stacks) {
    const directory = layout.directories[id];
    if (directory !== undefined) defaults.stack_options[id] = { directory };
  }
  const branch = await remoteDefaultBranch(root);
  if (branch && branch !== "main") defaults[platform] = { default_branch: branch };
  const preset = options.preset ?? "standard";
  let config = applyPreset(defaults, preset);
  const plan = async (candidate: RepokeeperConfig) => {
    const ctx = await buildContext(root, candidate, repo);
    return { ctx, outputs: planOutputs(ctx) };
  };
  if (options.interactive && confirm !== undefined) {
    // the default health settings stay at hand for a preset that left the module out
    const health = defaults.modules.health;
    if (health) config = await chooseModules(config, health, plan, { ...io, confirm });
  }
  const { ctx, outputs } = await plan(config);
  const adopt = options.adoptAll ? ("all" as const) : new Set(options.adopt);
  const result = await computeSync(root, outputs, null, { adopt, accept: new Set() });
  if (!options.dryRun) await guardUncommitted(root, result, options.force);
  printResult(io, result);
  if (options.dryRun) {
    io.out("dry run: nothing written");
    return 0;
  }
  if (options.interactive && confirm !== undefined && !(await confirm("Write these files?", true))) {
    io.out("nothing written");
    return 0;
  }
  await writeFile(join(root, CONFIG_FILE), renderConfig(config));
  await applySync(root, result, null, STANDARD_VERSION);
  io.out(`applied standard ${STANDARD_VERSION}; wrote ${CONFIG_FILE}`);
  await printWarnings(root, ctx, io);
  for (const step of await nextSteps(root, ctx, result)) io.out(`next: ${step}`);
  if (config.github?.protect || config.github?.security) {
    io.out("next: run `repokeeper github apply` to put the branch protection and security settings in place");
  }
  io.out(`next: commit with "chore(repokeeper): apply standard ${STANDARD_VERSION}"`);
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
