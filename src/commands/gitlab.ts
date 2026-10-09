import type { Io } from "../cli.js";
import { loadConfig } from "../config/load.js";
import { UsageError } from "../errors.js";
import { repoInfo } from "../git.js";
import { gitlabRestApi, resolveGitlabToken } from "../gitlab/api.js";
import { planGitlab } from "../gitlab/settings.js";
import type { CommandOptions } from "./report.js";

/** `repokeeper gitlab apply`: diff the project's GitLab settings against `gitlab:` and apply on confirmation. */
export async function gitlabApplyCommand(root: string, options: CommandOptions, io: Io): Promise<number> {
  const config = await loadConfig(root);
  if (config.platform !== "gitlab") throw new UsageError(`this repository uses the ${config.platform} platform`);
  const repo = await repoInfo(root, "gitlab");
  if (!repo.owner) throw new UsageError("the origin remote is not a GitLab project");
  const path = `${repo.owner}/${repo.name}`;
  const host = repo.host ?? "gitlab.com";
  const api = io.gitlabApi ?? gitlabRestApi(await resolveGitlabToken(host), host);
  // the jobs that wait for a secret: reported when it is missing, never created
  const secrets = [
    ...(config.modules.release ? [{ key: "GITLAB_TOKEN", job: "release" }] : []),
    ...(config.modules.deps ? [{ key: "RENOVATE_TOKEN", job: "renovate" }] : []),
  ];
  const { changes, notes } = await planGitlab(api, path, config.gitlab ?? {}, secrets);
  if (changes.length === 0) io.out(`GitLab settings of ${path} match .repokeeper.yml`);
  for (const change of changes) io.out(`change     ${change.setting}: ${change.from} -> ${change.to}`);
  for (const note of notes) io.out(`note: ${note}`);
  if (changes.length === 0) return 0;
  if (options.dryRun) {
    io.out("dry run: nothing applied");
    return 0;
  }
  const question = `apply ${changes.length} change(s) to ${path}?`;
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
