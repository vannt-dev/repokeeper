import { defaultBranch, STACK_IDS } from "../config/types.js";
import {
  MANAGED_HEADER,
  type ModuleContext,
  type Output,
  type PlatformAdapter,
  type ReleaseInfo,
  type RepoInfo,
} from "../model.js";
import { releaseFiles } from "../release/bump.js";
import { PACKAGE_VERSION, TOOL_VERSIONS } from "../version.js";
import { FOR_CHANGES, NOT_SCHEDULED, NOT_THE_RELEASE_COMMIT, STACK_JOB_KEYS, stackJobs } from "./gitlab-jobs.js";

const md = (path: string, body: string): Output => ({
  kind: "file",
  module: "health",
  path,
  content: `<!-- ${MANAGED_HEADER} -->\n\n${body}`,
});

/** Web address of the GitLab instance the repository lives on. */
const baseUrl = (repo: RepoInfo) => `https://${repo.host ?? "gitlab.com"}`;

const CI_FILE = ".gitlab-ci.yml";
const CI_KEYS = ["workflow", "node", "go", ...STACK_JOB_KEYS, "commits", "repokeeper", "renovate", "release"] as const;

/** One managed top-level key of .gitlab-ci.yml; keys the user adds are left alone. */
const ciKey = (module: string, key: string, value: unknown): Output => ({
  kind: "yaml",
  module,
  path: CI_FILE,
  keyPath: [key],
  value,
  order: CI_KEYS,
});

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
    rules: [{ if: FOR_CHANGES }],
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

/**
 * The go stack's CI inputs as a GitLab job. No module cache: it would have to live inside the project
 * folder, where `gofmt -l .` would read it as the project's own code.
 */
function goJob(input: Record<string, string>): Record<string, unknown> {
  // setup-go's "stable" is the image's `latest` tag
  const versions = (JSON.parse(input["go-versions"] ?? '["stable"]') as string[]).map((version) =>
    version === "stable" ? "latest" : version,
  );
  return {
    stage: "test",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
    image: "golang:${GO_VERSION}",
    parallel: { matrix: [{ GO_VERSION: versions }] },
    rules: [{ if: FOR_CHANGES }],
    script: JSON.parse(input.commands ?? "[]") as string[],
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

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * semantic-release and the plugins it does not bundle, from a scratch directory. It resolves plugins next to
 * itself before it looks in the project, so the project needs none of them installed.
 *
 * @param exec Whether the release runs a command of its own (the version bump of a stack npm does not know).
 */
const semanticRelease = (exec: boolean) => `dir="$(mktemp -d)"
(cd "$dir" && echo '{ "private": true }' > package.json && npm install --no-audit --no-fund semantic-release@${TOOL_VERSIONS.semanticRelease} @semantic-release/changelog@${TOOL_VERSIONS.semanticReleaseChangelog} @semantic-release/git@${TOOL_VERSIONS.semanticReleaseGit} @semantic-release/gitlab@${TOOL_VERSIONS.semanticReleaseGitlab}${exec ? ` @semantic-release/exec@${TOOL_VERSIONS.semanticReleaseExec}` : ""} conventional-changelog-conventionalcommits@${TOOL_VERSIONS.conventionalCommitsPreset})
"$dir/node_modules/.bin/semantic-release"
`;

export const gitlabPlatform: PlatformAdapter = {
  id: "gitlab",
  stacks: STACK_IDS,
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

  // Renovate finds the package managers itself, so the Dependabot ecosystem names are not needed
  dependencyUpdates(): Output[] {
    return [
      {
        kind: "file",
        module: "deps",
        path: "renovate.json",
        content: json({
          $schema: "https://docs.renovatebot.com/renovate-schema.json",
          // chore commits pass commitlint, as the Dependabot prefix does on GitHub. No schedule preset: the
          // pipeline schedule sets the cadence, and a Renovate schedule would skip runs outside its own window
          extends: ["config:recommended", ":semanticCommits", ":semanticCommitTypeAll(chore)"],
          packageRules: [
            { matchUpdateTypes: ["minor", "patch"], groupName: "minor and patch updates" },
            // @types/node majors track the Node.js line a project runs on, which the project chooses
            { matchPackageNames: ["@types/node"], matchUpdateTypes: ["major"], enabled: false },
          ],
        }),
      },
      // runs from a pipeline schedule of the repository; without the token or a schedule it never starts
      ciKey("deps", "renovate", {
        stage: "test",
        image: `renovate/renovate:${TOOL_VERSIONS.renovate}`,
        rules: [{ if: '$CI_PIPELINE_SOURCE == "schedule" && $RENOVATE_TOKEN' }],
        variables: {
          RENOVATE_PLATFORM: "gitlab",
          RENOVATE_ENDPOINT: "$CI_API_V4_URL",
          RENOVATE_AUTODISCOVER: "false",
          RENOVATE_ONBOARDING: "false",
        },
        script: ['renovate "$CI_PROJECT_PATH"'],
      }),
    ];
  },
  ciWorkflow(ctx: ModuleContext): Output[] {
    const jobs: Output[] = [];
    const node = ctx.stacks.find((stack) => stack.id === "node")?.ci;
    if (node) jobs.push(ciKey("ci", "node", nodeJob(node.with)));
    const go = ctx.stacks.find((stack) => stack.id === "go")?.ci;
    if (go) jobs.push(ciKey("ci", "go", goJob(go.with)));
    for (const stack of ctx.stacks) {
      for (const { key, job } of stackJobs(stack)) jobs.push(ciKey("ci", key, job));
    }
    if (ctx.config.modules.commits) {
      jobs.push(
        ciKey("ci", "commits", {
          stage: "test",
          image: TOOL_IMAGE,
          rules: [{ if: FOR_CHANGES }],
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
          rules: [{ if: FOR_CHANGES }],
          script: [`npx --yes repokeeper@${PACKAGE_VERSION} check`],
        }),
      );
    }
    if (jobs.length === 0) return [];
    return [
      // one pipeline per merge request, per push to the default branch and per schedule; none for other branches.
      // Tags are let through for jobs of the user's own, such as publishing: no managed job runs on one
      ciKey("ci", "workflow", {
        rules: [
          { if: '$CI_PIPELINE_SOURCE == "merge_request_event"' },
          { if: '$CI_PIPELINE_SOURCE == "schedule"' },
          { if: `$CI_COMMIT_BRANCH == "${defaultBranch(ctx.config)}"` },
          { if: "$CI_COMMIT_TAG" },
        ],
      }),
      ...jobs,
    ];
  },
  releaseAutomation(ctx: ModuleContext, release: ReleaseInfo): Output[] {
    const branch = defaultBranch(ctx.config);
    const npm = release.type === "node";
    // the files of the other stacks that hold a version; none for a Go module, whose version is its tag
    const versionFiles = npm ? [] : releaseFiles(release);
    return [
      {
        kind: "file",
        module: "release",
        path: ".releaserc.json",
        content: json({
          branches: [branch],
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a semantic-release template
          tagFormat: "v${version}",
          plugins: [
            ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
            ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
            ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
            // bumps package.json and the npm lock file; publishing stays the project's own business
            ...(npm ? [["@semantic-release/npm", { npmPublish: false }]] : []),
            // semantic-release knows no other stack's version file; repokeeper writes the version into it
            ...(versionFiles.length > 0
              ? [
                  [
                    "@semantic-release/exec",
                    { prepareCmd: `npx --yes repokeeper@${PACKAGE_VERSION} bump \${nextRelease.version}` },
                  ],
                ]
              : []),
            [
              "@semantic-release/git",
              {
                assets: [
                  "CHANGELOG.md",
                  ...(npm ? ["package.json", "package-lock.json", "npm-shrinkwrap.json"] : []),
                  ...versionFiles,
                ],
                // biome-ignore lint/suspicious/noTemplateCurlyInString: a semantic-release template
                message: "chore(release): ${nextRelease.version}",
              },
            ],
            "@semantic-release/gitlab",
          ],
        }),
      },
      // semantic-release pushes a commit and a tag, which the job token cannot do; without GITLAB_TOKEN the job is absent
      ciKey("release", "release", {
        stage: "deploy",
        image: TOOL_IMAGE,
        // not for its own commit: there is nothing new to release in it
        rules: [
          {
            if: `${NOT_SCHEDULED} && $CI_COMMIT_BRANCH == "${branch}" && $GITLAB_TOKEN && ${NOT_THE_RELEASE_COMMIT}`,
          },
        ],
        variables: { GIT_DEPTH: "0" },
        script: [semanticRelease(versionFiles.length > 0)],
      }),
    ];
  },
};
