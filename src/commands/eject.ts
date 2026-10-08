import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import type { Io } from "../cli.js";
import { CONFIG_FILE, loadConfig } from "../config/load.js";
import type { RepokeeperConfig } from "../config/types.js";
import { UsageError } from "../errors.js";
import { listWorkflows, readWorkflow } from "../templates.js";
import { PACKAGE_VERSION, REUSABLE_REPO } from "../version.js";
import type { CommandOptions } from "./report.js";
import { updateCommand } from "./update.js";

const WORKFLOWS = ".github/workflows";

/** Sets `github.workflows.source: local` in place, keeping every comment and the rest of the layout. */
export function setLocalWorkflows(text: string): string {
  const doc = parseDocument(text);
  doc.setIn(["github", "workflows", "source"], "local");
  // a ref belongs to a repository; the files of this one are called as they are on each commit
  doc.deleteIn(["github", "workflows", "ref"]);
  return doc.toString();
}

/**
 * Stops depending on repokeeper's repository for CI.
 *
 * Without `--to`: this repository gets its own copies of the reusable workflows its CI and release
 * call, and the callers are pointed at them. With `--to <folder>`: every reusable workflow is
 * written into that folder, for a repository of the organisation that the others then call.
 */
export async function ejectCommand(root: string, options: CommandOptions, io: Io): Promise<number> {
  if (options.to !== undefined) return ejectTo(resolve(root, options.to), options, io);

  const config = await loadConfig(root);
  if (config.platform !== "github") {
    throw new UsageError("eject is for GitHub: on GitLab every job is already generated into .gitlab-ci.yml");
  }
  const local: RepokeeperConfig = {
    ...config,
    github: { ...config.github, workflows: { source: "local" } },
  };
  const code = await updateCommand(root, options, io, {
    config: local,
    async beforeWrite() {
      const path = join(root, CONFIG_FILE);
      await writeFile(path, setLocalWorkflows(await readFile(path, "utf8")));
    },
  });
  if (code === 0 && !options.dryRun) {
    io.out(`the reusable workflows are now files of this repository, under ${WORKFLOWS}/, and yours to maintain`);
  }
  return code;
}

async function ejectTo(target: string, options: CommandOptions, io: Io): Promise<number> {
  const directory = join(target, WORKFLOWS);
  const files = listWorkflows();
  const existing = files.filter((file) => existsSync(join(directory, file)));
  if (existing.length > 0 && !options.force) {
    throw new UsageError(
      `${existing.map((file) => `${WORKFLOWS}/${file}`).join(", ")} already exist in ${target}; pass --force to replace them`,
    );
  }
  for (const file of files) io.out(`${existing.includes(file) ? "replace" : "create "}   ${WORKFLOWS}/${file}`);
  if (options.dryRun) {
    io.out("dry run: nothing written");
    return 0;
  }
  await mkdir(directory, { recursive: true });
  for (const file of files) {
    await writeFile(
      join(directory, file),
      `# Copied from repokeeper ${PACKAGE_VERSION} (https://github.com/${REUSABLE_REPO}).\n${readWorkflow(file)}`,
    );
  }
  io.out(`wrote ${files.length} reusable workflows to ${directory}`);
  io.out("next: commit and push them in that repository, and allow other repositories to call its workflows");
  io.out("next: in each repository that should call them, add to .repokeeper.yml and run `repokeeper update`:");
  io.out("        github:");
  io.out("          workflows:");
  io.out("            source: your-org/that-repository");
  io.out("            ref: main   # or a tag or commit of that repository");
  return 0;
}
