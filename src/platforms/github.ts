import { stringify } from "yaml";
import { defaultBranch } from "../config/types.js";
import { MANAGED_HEADER, type ModuleContext, type Output, type PlatformAdapter, type ReleaseInfo } from "../model.js";
import { PACKAGE_VERSION, REUSABLE_REPO, WORKFLOW_REF } from "../version.js";

const yamlFile = (module: string, path: string, data: unknown): Output => ({
  kind: "file",
  module,
  path,
  content: `# ${MANAGED_HEADER}\n${stringify(data)}`,
});

const WORKFLOW_KEYS = ["name", "on", "permissions", "concurrency", "env", "defaults", "jobs"] as const;

/** Reference to a reusable workflow; local inside the repository that hosts them. */
function workflowRef(ctx: ModuleContext, file: string): string {
  const self = ctx.repo.owner !== null && `${ctx.repo.owner}/${ctx.repo.name}` === REUSABLE_REPO;
  return self ? `./.github/workflows/${file}` : `${REUSABLE_REPO}/.github/workflows/${file}@${WORKFLOW_REF}`;
}

const workflowKey = (module: string, path: string, keyPath: string[], value: unknown): Output => ({
  kind: "yaml",
  module,
  path,
  keyPath,
  value,
  order: WORKFLOW_KEYS,
});

/** Waits briefly for the held runs to appear, since GitHub creates them just after the pull request event. */
const APPROVE_RELEASE_PR_RUNS = `for attempt in 1 2 3 4 5 6; do
  ids=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs?branch=$BRANCH&event=pull_request&status=action_required" --jq '.workflow_runs[].id')
  [ -n "$ids" ] && break
  sleep 10
done
if [ -z "$ids" ]; then echo "::notice::no held runs for $BRANCH"; fi
for id in $ids; do gh api -X POST "repos/$GITHUB_REPOSITORY/actions/runs/$id/approve"; done
`;

const RELEASE_PLEASE_SCHEMA = "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const githubPlatform: PlatformAdapter = {
  id: "github",

  communityFiles(ctx: ModuleContext): Output[] {
    const { owner, name } = ctx.repo;
    const outputs: Output[] = [
      yamlFile("health", ".github/ISSUE_TEMPLATE/bug_report.yml", {
        name: "Bug report",
        description: "Report something that does not work as expected",
        labels: ["bug"],
        body: [
          {
            type: "textarea",
            id: "what-happened",
            attributes: { label: "What happened?", description: "Include the steps to reproduce it." },
            validations: { required: true },
          },
          {
            type: "textarea",
            id: "expected",
            attributes: { label: "What did you expect?" },
            validations: { required: true },
          },
          { type: "input", id: "version", attributes: { label: "Version" } },
        ],
      }),
      yamlFile("health", ".github/ISSUE_TEMPLATE/feature_request.yml", {
        name: "Feature request",
        description: "Suggest an improvement",
        labels: ["enhancement"],
        body: [
          {
            type: "textarea",
            id: "problem",
            attributes: { label: "What problem would this solve?" },
            validations: { required: true },
          },
          { type: "textarea", id: "proposal", attributes: { label: "What do you propose?" } },
        ],
      }),
      yamlFile("health", ".github/ISSUE_TEMPLATE/config.yml", {
        blank_issues_enabled: false,
        contact_links: owner
          ? [
              {
                name: "Report a security vulnerability",
                url: `https://github.com/${owner}/${name}/security/advisories/new`,
                about: "Please report vulnerabilities privately.",
              },
            ]
          : [],
      }),
      {
        kind: "file",
        module: "health",
        path: ".github/pull_request_template.md",
        content: `<!-- ${MANAGED_HEADER} -->\n\n## Summary\n\n## Testing\n\n- [ ] Tests added or updated\n- [ ] Commit messages follow Conventional Commits\n`,
      },
    ];
    const health = ctx.config.modules.health;
    if (health && health.codeowners.length > 0) {
      outputs.push({
        kind: "file",
        module: "health",
        path: ".github/CODEOWNERS",
        content: `# ${MANAGED_HEADER}\n* ${health.codeowners.join(" ")}\n`,
      });
    }
    return outputs;
  },

  dependencyUpdates(ecosystems: string[]): Output[] {
    const updates = [...new Set([...ecosystems, "github-actions"])].map((ecosystem) => ({
      "package-ecosystem": ecosystem,
      directory: "/",
      schedule: { interval: "weekly" },
      groups: { [`${ecosystem}-minor-and-patch`]: { "update-types": ["minor", "patch"] } },
      // Dependabot infers a Conventional Commits prefix only from history; young repositories fail commitlint
      "commit-message": { prefix: "chore", include: "scope" },
      // @types/node majors track the Node.js line a project runs on, which the project chooses
      ...(ecosystem === "npm"
        ? { ignore: [{ "dependency-name": "@types/node", "update-types": ["version-update:semver-major"] }] }
        : {}),
    }));
    return [yamlFile("deps", ".github/dependabot.yml", { version: 2, updates })];
  },

  ciWorkflow(ctx: ModuleContext): Output[] {
    const path = ".github/workflows/ci.yml";
    const jobs: Output[] = [];
    for (const stack of ctx.stacks) {
      if (stack.ci) {
        jobs.push(
          workflowKey("ci", path, ["jobs", stack.id], {
            uses: workflowRef(ctx, stack.ci.workflow),
            with: stack.ci.with,
          }),
        );
      }
    }
    if (ctx.config.modules.commits) {
      jobs.push(workflowKey("ci", path, ["jobs", "commits"], { uses: workflowRef(ctx, "commitlint.yml") }));
    }
    if (ctx.config.modules.drift) {
      jobs.push(
        workflowKey("ci", path, ["jobs", "repokeeper"], {
          uses: workflowRef(ctx, "repokeeper-check.yml"),
          with: { version: PACKAGE_VERSION },
        }),
      );
    }
    if (jobs.length === 0) return [];
    return [
      workflowKey("ci", path, ["name"], "ci"),
      workflowKey("ci", path, ["on"], { pull_request: null, push: { branches: [defaultBranch(ctx.config)] } }),
      workflowKey("ci", path, ["permissions"], { contents: "read" }),
      // a new push to a pull request makes its earlier run pointless; runs on the default branch always finish
      workflowKey("ci", path, ["concurrency"], {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
        group: "${{ github.workflow }}-${{ github.ref }}",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
        "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      }),
      ...jobs,
    ];
  },

  releaseAutomation(ctx: ModuleContext, release: ReleaseInfo): Output[] {
    const path = ".github/workflows/release.yml";
    const seed = release.version ?? ctx.repo.releasedVersion ?? "0.0.0";
    return [
      {
        kind: "file",
        module: "release",
        path: "release-please-config.json",
        content: json({
          $schema: RELEASE_PLEASE_SCHEMA,
          packages: {
            ".": {
              "release-type": release.type,
              "changelog-path": "CHANGELOG.md",
              "bump-minor-pre-major": true,
              "include-component-in-tag": false,
              ...(release.extraFiles && release.extraFiles.length > 0 ? { "extra-files": release.extraFiles } : {}),
              ...(release.versionFile ? { "version-file": release.versionFile } : {}),
              // Without it a pom at a release version first gets a pull request that only bumps to -SNAPSHOT
              ...(release.type === "maven" ? { "skip-snapshot": true } : {}),
              // release-please makes a repository's first release 1.0.0 unless told otherwise; a release tag means
              // there was one, even when a version file release-please never bumps still reads 0.0.0
              ...(seed === "0.0.0" && !ctx.repo.releasedVersion ? { "initial-version": "0.1.0" } : {}),
            },
          },
        }),
      },
      {
        kind: "seed",
        module: "release",
        path: ".release-please-manifest.json",
        content: json({ ".": seed }),
      },
      workflowKey("release", path, ["name"], "release"),
      workflowKey("release", path, ["on"], { push: { branches: [defaultBranch(ctx.config)] } }),
      workflowKey("release", path, ["permissions"], { contents: "read" }),
      workflowKey("release", path, ["jobs", "release"], {
        uses: workflowRef(ctx, "release-please.yml"),
        permissions: { contents: "write", "pull-requests": "write", issues: "write" },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
        secrets: { token: "${{ secrets.RELEASE_PLEASE_TOKEN }}" },
      }),
      // GitHub holds the pull_request runs of a pull request that GITHUB_TOKEN opened until someone
      // approves them, so required checks never report; approve them for the release pull request
      workflowKey("release", path, ["jobs", "release-pr-ci"], {
        needs: "release",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
        if: "${{ needs.release.outputs.pr_branch != '' }}",
        "runs-on": "ubuntu-latest",
        permissions: { actions: "write" },
        steps: [
          {
            env: {
              // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
              GH_TOKEN: "${{ github.token }}",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
              BRANCH: "${{ needs.release.outputs.pr_branch }}",
            },
            run: APPROVE_RELEASE_PR_RUNS,
          },
        ],
      }),
    ];
  },
};
