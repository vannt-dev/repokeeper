import { defaultBranch } from "../config/types.js";
import { MANAGED_HEADER, type ModuleContext, type Output, type PlatformAdapter, type RepoInfo } from "../model.js";
import { PACKAGE_VERSION, TOOL_VERSIONS } from "../version.js";

const md = (path: string, body: string): Output => ({
  kind: "file",
  module: "health",
  path,
  content: `<!-- ${MANAGED_HEADER} -->\n\n${body}`,
});

/** Web address of the GitLab instance the repository lives on. */
const baseUrl = (repo: RepoInfo) => `https://${repo.host ?? "gitlab.com"}`;

const CI_FILE = ".gitlab-ci.yml";
const CI_KEYS = ["workflow", "node", "commits", "repokeeper", "renovate", "release"] as const;

/** One managed top-level key of .gitlab-ci.yml; keys the user adds are left alone. */
const ciKey = (module: string, key: string, value: unknown): Output => ({
  kind: "yaml",
  module,
  path: CI_FILE,
  keyPath: [key],
  value,
  order: CI_KEYS,
});

const NOT_SCHEDULED = '$CI_PIPELINE_SOURCE != "schedule"';
/** Image of the jobs that only run tools, whatever Node.js versions the project tests on. */
const TOOL_IMAGE = "node:24";

/** The node stack's CI inputs, as the GitHub reusable workflow receives them, as a GitLab job. */
function nodeJob(input: Record<string, string>): Record<string, unknown> {
  const pm = input["package-manager"] ?? "npm";
  const cached = input.cache === "npm";
  const scripts = JSON.parse(input.scripts ?? "[]") as string[];
  return {
    stage: "test",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
    image: "node:${NODE_VERSION}",
    parallel: { matrix: [{ NODE_VERSION: JSON.parse(input["node-versions"] ?? '["22","24"]') as string[] }] },
    rules: [{ if: NOT_SCHEDULED }],
    variables: {
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      ...(cached ? { npm_config_cache: "$CI_PROJECT_DIR/.npm" } : {}),
    },
    ...(cached ? { cache: { key: { files: ["package-lock.json"] }, paths: [".npm/"] } } : {}),
    script: [
      ...(pm === "npm" ? [] : ["corepack enable"]),
      input["install-command"] ?? "npm ci",
      ...scripts.map((script) => `${pm} run ${script}`),
    ],
  };
}

/** commitlint from a scratch directory, so the project needs no commitlint of its own. */
const COMMITLINT = `dir="$(mktemp -d)"
(cd "$dir" && echo '{ "private": true }' > package.json && npm install --no-audit --no-fund @commitlint/cli@${TOOL_VERSIONS.commitlintCli} @commitlint/config-conventional@${TOOL_VERSIONS.commitlintConventional})
cat > "$dir/commitlint.config.mjs" <<'EOF'
export default { extends: ["@commitlint/config-conventional"], rules: { "header-max-length": [2, "always", 100] } };
EOF
lint() { "$dir/node_modules/.bin/commitlint" --config "$dir/commitlint.config.mjs" --verbose "$@"; }
# a merged results pipeline runs on a merge commit; the commits to lint end at the source branch
head="$CI_MERGE_REQUEST_SOURCE_BRANCH_SHA"
[ -n "$head" ] || head="$CI_COMMIT_SHA"
if [ -n "$CI_MERGE_REQUEST_DIFF_BASE_SHA" ]; then
  lint --from "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --to "$head"
else
  lint --last
fi
`;

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
  ciWorkflow(ctx: ModuleContext): Output[] {
    const jobs: Output[] = [];
    const node = ctx.stacks.find((stack) => stack.id === "node")?.ci;
    if (node) jobs.push(ciKey("ci", "node", nodeJob(node.with)));
    if (ctx.config.modules.commits) {
      jobs.push(
        ciKey("ci", "commits", {
          stage: "test",
          image: TOOL_IMAGE,
          rules: [{ if: NOT_SCHEDULED }],
          variables: { GIT_DEPTH: "0" },
          script: [COMMITLINT],
        }),
      );
    }
    if (ctx.config.modules.drift) {
      jobs.push(
        ciKey("ci", "repokeeper", {
          stage: "test",
          image: TOOL_IMAGE,
          rules: [{ if: NOT_SCHEDULED }],
          script: [`npx --yes repokeeper@${PACKAGE_VERSION} check`],
        }),
      );
    }
    if (jobs.length === 0) return [];
    return [
      // one pipeline per merge request, per push to the default branch and per schedule; none for other branches or tags
      ciKey("ci", "workflow", {
        rules: [
          { if: '$CI_PIPELINE_SOURCE == "merge_request_event"' },
          { if: '$CI_PIPELINE_SOURCE == "schedule"' },
          { if: `$CI_COMMIT_BRANCH == "${defaultBranch(ctx.config)}"` },
        ],
      }),
      ...jobs,
    ];
  },
  releaseAutomation: () => [],
};
