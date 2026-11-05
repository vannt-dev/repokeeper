import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Io } from "../cli.js";
import { loadConfig } from "../config/load.js";
import type { RepokeeperConfig } from "../config/types.js";
import { UsageError } from "../errors.js";
import { repoInfo } from "../git.js";
import { resolveToken, restApi } from "../github/api.js";
import { CI_RESULT_CHECK } from "../github/checks.js";
import { type GithubSettings, planGithub } from "../github/settings.js";
import type { CommandOptions } from "./report.js";

/**
 * The settings `github apply` puts in place: the `github:` section, plus what a module needs of the
 * repository. `modules.automerge` turns auto-merge on unless `github.merge.auto_merge` says otherwise.
 * With `modules.ci` on, `protect` requires the `CI result` check unless `required_checks` names others.
 */
export function githubSettings(config: RepokeeperConfig): GithubSettings {
  let settings = config.github ?? {};
  if (config.modules.automerge && settings.merge?.auto_merge === undefined) {
    settings = { ...settings, merge: { ...settings.merge, auto_merge: true } };
  }
  if (config.modules.ci && settings.protect && settings.protect.required_checks === undefined) {
    settings = { ...settings, protect: { ...settings.protect, required_checks: [CI_RESULT_CHECK] } };
  }
  return settings;
}

/** The text of every workflow file in the checkout. */
async function readWorkflows(root: string): Promise<string[]> {
  const dir = join(root, ".github", "workflows");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((name) => /\.ya?ml$/.test(name)).sort();
  return Promise.all(files.map((name) => readFile(join(dir, name), "utf8")));
}

/** `repokeeper github apply`: diff the repository's GitHub settings against `github:` and apply on confirmation. */
export async function githubApplyCommand(root: string, options: CommandOptions, io: Io): Promise<number> {
  const config = await loadConfig(root, io.githubApi);
  if (config.platform !== "github") throw new UsageError(`this repository uses the ${config.platform} platform`);
  const repo = await repoInfo(root);
  if (!repo.owner) throw new UsageError("the origin remote is not a GitHub repository");
  const slug = `${repo.owner}/${repo.name}`;
  const api = io.githubApi ?? restApi(await resolveToken());
  const changes = await planGithub(api, repo.owner, repo.name, githubSettings(config), {
    workflows: await readWorkflows(root),
    warn: (message) => io.out(`warning    ${message}`),
  });
  if (changes.length === 0) {
    io.out(`GitHub settings of ${slug} match .repokeeper.yml`);
    return 0;
  }
  for (const change of changes) io.out(`change     ${change.setting}: ${change.from} -> ${change.to}`);
  if (options.dryRun) {
    io.out("dry run: nothing applied");
    return 0;
  }
  const question = `apply ${changes.length} change(s) to ${slug}?`;
  const confirmed = options.yes || (io.confirm ? await io.confirm(question) : false);
  if (!confirmed) {
    io.out("nothing applied; pass --yes to apply");
    return 1;
  }
  for (const change of changes) {
    await change.apply(api);
    io.out(`applied    ${change.setting}`);
  }
  return 0;
}
