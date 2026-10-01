import { MANAGED_HEADER, type ModuleContext, type Output, type PlatformAdapter, type RepoInfo } from "../model.js";

const md = (path: string, body: string): Output => ({
  kind: "file",
  module: "health",
  path,
  content: `<!-- ${MANAGED_HEADER} -->\n\n${body}`,
});

/** Web address of the GitLab instance the repository lives on. */
const baseUrl = (repo: RepoInfo) => `https://${repo.host ?? "gitlab.com"}`;

export const gitlabPlatform: PlatformAdapter = {
  id: "gitlab",
  stacks: ["node"],
  changeRequest: "merge request",

  profileUrl: (repo) => (repo.owner ? `${baseUrl(repo)}/${repo.owner}` : null),

  securityReport: (repo) =>
    repo.owner
      ? `by opening a [confidential issue](${baseUrl(repo)}/${repo.owner}/${repo.name}/-/issues/new?issue%5Bconfidential%5D=true)`
      : "by opening a confidential issue in the repository",

  communityFiles(ctx: ModuleContext): Output[] {
    const outputs: Output[] = [
      md(
        ".gitlab/issue_templates/Bug.md",
        "## What happened?\n\n<!-- Include the steps to reproduce it. -->\n\n## What did you expect?\n\n## Version\n\n/label ~bug\n",
      ),
      md(
        ".gitlab/issue_templates/Feature.md",
        "## What problem would this solve?\n\n## What do you propose?\n\n/label ~enhancement\n",
      ),
      md(
        ".gitlab/merge_request_templates/Default.md",
        "## Summary\n\n## Testing\n\n- [ ] Tests added or updated\n- [ ] Commit messages follow Conventional Commits\n",
      ),
    ];
    const health = ctx.config.modules.health;
    if (health && health.codeowners.length > 0) {
      outputs.push({
        kind: "file",
        module: "health",
        path: ".gitlab/CODEOWNERS",
        content: `# ${MANAGED_HEADER}\n* ${health.codeowners.join(" ")}\n`,
      });
    }
    return outputs;
  },

  dependencyUpdates: () => [],
  ciWorkflow: () => [],
  releaseAutomation: () => [],
};
