import type { Io } from "../cli.js";
import { loadConfig } from "../config/load.js";
import { UsageError } from "../errors.js";
import { repoInfo } from "../git.js";
import { resolveToken, restApi } from "../github/api.js";
import { planGithub } from "../github/settings.js";
import type { CommandOptions } from "./report.js";

/** `repokeeper github apply`: diff the repository's GitHub settings against `github:` and apply on confirmation. */
export async function githubApplyCommand(root: string, options: CommandOptions, io: Io): Promise<number> {
  const config = await loadConfig(root);
  const repo = await repoInfo(root);
  if (!repo.owner) throw new UsageError("the origin remote is not a GitHub repository");
  const slug = `${repo.owner}/${repo.name}`;
  const api = io.githubApi ?? restApi(await resolveToken());
  const changes = await planGithub(api, repo.owner, repo.name, config.github ?? {});
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
