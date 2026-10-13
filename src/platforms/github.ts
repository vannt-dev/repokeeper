import { stringify } from "yaml";
import { CONFIG_FILE } from "../config/load.js";
import { defaultBranch, STACK_IDS, type StackId } from "../config/types.js";
import { ConfigError } from "../errors.js";
import {
  type DependencyUpdate,
  MANAGED_HEADER,
  type ModuleContext,
  type Output,
  type PlatformAdapter,
  type ReleaseInfo,
} from "../model.js";
import { readWorkflow } from "../templates.js";
import { EXACT_WORKFLOW_REF, PACKAGE_VERSION, REUSABLE_REPO, WORKFLOW_REF } from "../version.js";

const yamlFile = (module: string, path: string, data: unknown): Output => ({
  kind: "file",
  module,
  path,
  content: `# ${MANAGED_HEADER}\n${stringify(data)}`,
});

const WORKFLOW_KEYS = ["name", "on", "permissions", "concurrency", "env", "defaults", "jobs"] as const;

/** Where the reusable workflows are called from: this repository, or a repository at a ref. */
type WorkflowOrigin = { local: true; self: boolean } | { local: false; repo: string; ref: string; pinned: boolean };

function workflowOrigin(ctx: ModuleContext): WorkflowOrigin {
  // the repository that hosts the workflows calls its own files
  if (ctx.repo.owner !== null && `${ctx.repo.owner}/${ctx.repo.name}` === REUSABLE_REPO)
    return { local: true, self: true };
  const { source, ref } = ctx.config.github?.workflows ?? {};
  if (source === "local") return { local: true, self: false };
  const repo = source ?? REUSABLE_REPO;
  if (ref === "exact") {
    if (repo !== REUSABLE_REPO) {
      throw new ConfigError(
        `${CONFIG_FILE}: github.workflows.ref: exact follows repokeeper's own releases; for ${repo}, name a tag, a branch or a commit`,
      );
    }
    return { local: false, repo, ref: EXACT_WORKFLOW_REF, pinned: true };
  }
  // a copy in a repository of your own has no release tags of repokeeper's to follow
  return {
    local: false,
    repo,
    ref: ref ?? (repo === REUSABLE_REPO ? WORKFLOW_REF : "main"),
    pinned: ref !== undefined,
  };
}

/** Reference to a reusable workflow, as the `uses` of a caller job. */
function workflowRef(ctx: ModuleContext, file: string): string {
  const origin = workflowOrigin(ctx);
  return origin.local ? `./.github/workflows/${file}` : `${origin.repo}/.github/workflows/${file}@${origin.ref}`;
}

/**
 * The reusable workflows themselves, for a repository that keeps its own copies. Seeds: written
 * once and from then on the repository's, so its owners decide when a copy changes.
 */
function localWorkflows(ctx: ModuleContext, module: string, files: string[]): Output[] {
  const origin = workflowOrigin(ctx);
  if (!origin.local || origin.self) return [];
  return [...new Set(files)].map((file) => ({
    kind: "seed" as const,
    module,
    path: `.github/workflows/${file}`,
    content: `# Copied from repokeeper ${PACKAGE_VERSION} (https://github.com/${REUSABLE_REPO}). This copy is yours: repokeeper does not update it.\n${readWorkflow(file)}`,
  }));
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
const APPROVE_HELD_PR_RUNS = `for attempt in 1 2 3 4 5 6; do
  ids=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs?branch=$BRANCH&event=pull_request&status=action_required" --jq '.workflow_runs[].id')
  [ -n "$ids" ] && break
  sleep 10
done
if [ -z "$ids" ]; then echo "::notice::no held runs for $BRANCH"; fi
for id in $ids; do gh api -X POST "repos/$GITHUB_REPOSITORY/actions/runs/$id/approve"; done
`;

interface CodeqlLanguage {
  /** CodeQL's identifier of the language. */
  language: string;
  /** `none`: read from source. `autobuild`: CodeQL has to watch a build, and works out how to run one. */
  "build-mode": "none" | "autobuild";
}

/**
 * What CodeQL calls each stack's language, or null for a stack it cannot analyze. A stack with no line
 * here does not compile, so that a new one has to say.
 *
 * Go has no analysis without a build. Java is read from source but Kotlin is not, and both share one
 * identifier, so a Kotlin stack asks for the build.
 */
export const CODEQL_LANGUAGES: Record<StackId, CodeqlLanguage | null> = {
  node: { language: "javascript-typescript", "build-mode": "none" },
  python: { language: "python", "build-mode": "none" },
  dart: null,
  script: null,
  java: { language: "java-kotlin", "build-mode": "none" },
  dotnet: { language: "csharp", "build-mode": "none" },
  go: { language: "go", "build-mode": "autobuild" },
  rust: { language: "rust", "build-mode": "none" },
  kotlin: { language: "java-kotlin", "build-mode": "autobuild" },
  php: null,
  ruby: { language: "ruby", "build-mode": "none" },
  docker: null,
};

/** The languages to analyze, each once: those of the stacks, then the workflow files themselves. */
function codeqlLanguages(ctx: ModuleContext): CodeqlLanguage[] {
  const found = new Map<string, CodeqlLanguage>();
  for (const stack of ctx.stacks) {
    const entry = CODEQL_LANGUAGES[stack.id];
    if (!entry) continue;
    // a language two stacks share is built when either of them needs the build
    if (found.get(entry.language)?.["build-mode"] !== "autobuild") found.set(entry.language, entry);
  }
  // every repository this writes to has workflows: at the least, the one that runs the analysis
  return [...found.values(), { language: "actions", "build-mode": "none" }];
}

const RELEASE_PLEASE_SCHEMA = "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json";
// release-please's own php sections (src/strategies/php.ts) with chore hidden, as every other strategy has it
const PHP_CHANGELOG_SECTIONS = [
  { type: "feat", section: "Features" },
  { type: "fix", section: "Bug Fixes" },
  { type: "perf", section: "Performance Improvements" },
  { type: "revert", section: "Reverts" },
  { type: "chore", section: "Miscellaneous Chores", hidden: true },
  { type: "docs", section: "Documentation", hidden: true },
  { type: "style", section: "Styles", hidden: true },
  { type: "refactor", section: "Code Refactoring", hidden: true },
  { type: "test", section: "Tests", hidden: true },
  { type: "build", section: "Build System", hidden: true },
  { type: "ci", section: "Continuous Integration", hidden: true },
];
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const githubPlatform: PlatformAdapter = {
  id: "github",
  stacks: STACK_IDS,
  changeRequest: "pull request",
  profileUrl: (repo) => (repo.owner ? `https://github.com/${repo.owner}` : null),
  securityReport: (repo) =>
    repo.owner
      ? `through [GitHub security advisories](https://github.com/${repo.owner}/${repo.name}/security/advisories/new)`
      : "through the repository's Security tab (Report a vulnerability)",

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

  dependencyUpdates(requested: DependencyUpdate[], ctx: ModuleContext): Output[] {
    // a pinned reference is moved by `repokeeper update` or by its owner in .repokeeper.yml; a
    // Dependabot bump of it would edit a key repokeeper manages and show up as drift every time
    const origin = workflowOrigin(ctx);
    const pinnedWorkflows = !origin.local && origin.pinned ? [{ "dependency-name": `${origin.repo}*` }] : [];
    // workflows always live at the root, whatever folders the stacks are in
    const all = [...requested, { ecosystem: "github-actions", directory: "/" }];
    const unique = all.filter(
      (update, index) =>
        all.findIndex((other) => other.ecosystem === update.ecosystem && other.directory === update.directory) ===
        index,
    );
    const updates = unique.map(({ ecosystem, directory }) => ({
      "package-ecosystem": ecosystem,
      directory,
      schedule: { interval: "weekly" },
      groups: { [`${ecosystem}-minor-and-patch`]: { "update-types": ["minor", "patch"] } },
      // Dependabot infers a Conventional Commits prefix only from history; young repositories fail commitlint
      "commit-message": { prefix: "chore", include: "scope" },
      // @types/node majors track the Node.js line a project runs on, which the project chooses
      ...(ecosystem === "npm"
        ? { ignore: [{ "dependency-name": "@types/node", "update-types": ["version-update:semver-major"] }] }
        : {}),
      ...(ecosystem === "github-actions" && pinnedWorkflows.length > 0 ? { ignore: pinnedWorkflows } : {}),
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
            with: stack.directory ? { ...stack.ci.with, "working-directory": stack.directory } : stack.ci.with,
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
    const called = [
      ...ctx.stacks.flatMap((stack) => (stack.ci ? [stack.ci.workflow] : [])),
      ...(ctx.config.modules.commits ? ["commitlint.yml"] : []),
      ...(ctx.config.modules.drift ? ["repokeeper-check.yml"] : []),
    ];
    return [
      ...localWorkflows(ctx, "ci", called),
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

  standardUpdates(ctx: ModuleContext): Output[] {
    // not the name of the reusable workflow it calls: a repository that keeps its own copies has both
    const path = ".github/workflows/repokeeper-autoupdate.yml";
    return [
      ...localWorkflows(ctx, "autoupdate", ["repokeeper-update.yml"]),
      workflowKey("autoupdate", path, ["name"], "repokeeper update"),
      // weekly and by hand, never on a push: the pull request it opens must not start it again
      workflowKey("autoupdate", path, ["on"], { schedule: [{ cron: "23 5 * * 1" }], workflow_dispatch: null }),
      workflowKey("autoupdate", path, ["permissions"], { contents: "read" }),
      workflowKey("autoupdate", path, ["jobs", "update"], {
        uses: workflowRef(ctx, "repokeeper-update.yml"),
        permissions: { contents: "write", "pull-requests": "write" },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
        secrets: { token: "${{ secrets.REPOKEEPER_TOKEN }}" },
      }),
      // as for the release pull request: one that GITHUB_TOKEN opened has its runs held until approved
      workflowKey("autoupdate", path, ["jobs", "update-pr-ci"], {
        needs: "update",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
        if: "${{ needs.update.outputs.pr_branch != '' }}",
        "runs-on": "ubuntu-latest",
        permissions: { actions: "write" },
        steps: [
          {
            env: {
              // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
              GH_TOKEN: "${{ github.token }}",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
              BRANCH: "${{ needs.update.outputs.pr_branch }}",
            },
            run: APPROVE_HELD_PR_RUNS,
          },
        ],
      }),
    ];
  },

  codeScanning(ctx: ModuleContext): Output[] {
    // not the name of the reusable workflow it calls: a repository that keeps its own copies has both
    const path = ".github/workflows/security.yml";
    return [
      ...localWorkflows(ctx, "security", ["codeql.yml"]),
      workflowKey("security", path, ["name"], "security"),
      workflowKey("security", path, ["on"], {
        pull_request: null,
        push: { branches: [defaultBranch(ctx.config)] },
        // weekly as well: new queries find things in code that has not changed
        schedule: [{ cron: "41 4 * * 3" }],
      }),
      workflowKey("security", path, ["permissions"], { contents: "read" }),
      workflowKey("security", path, ["concurrency"], {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
        group: "${{ github.workflow }}-${{ github.ref }}",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
        "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      }),
      workflowKey("security", path, ["jobs", "codeql"], {
        uses: workflowRef(ctx, "codeql.yml"),
        // what the called job asks for; a called workflow cannot have more than its caller grants
        permissions: { "security-events": "write", actions: "read", contents: "read" },
        with: { languages: JSON.stringify(codeqlLanguages(ctx)) },
      }),
    ];
  },

  releaseAutomation(ctx: ModuleContext, release: ReleaseInfo, directory?: string): Output[] {
    const path = ".github/workflows/release.yml";
    const seed = release.version ?? ctx.repo.releasedVersion ?? "0.0.0";
    // release-please names a package by its folder; its changelog and extra files are relative to it
    const packagePath = directory ?? ".";
    return [
      {
        kind: "file",
        module: "release",
        path: "release-please-config.json",
        content: json({
          $schema: RELEASE_PLEASE_SCHEMA,
          packages: {
            [packagePath]: {
              "release-type": release.type,
              "changelog-path": "CHANGELOG.md",
              "bump-minor-pre-major": true,
              "include-component-in-tag": false,
              ...(release.extraFiles && release.extraFiles.length > 0 ? { "extra-files": release.extraFiles } : {}),
              ...(release.versionFile ? { "version-file": release.versionFile } : {}),
              // Without it a pom at a release version first gets a pull request that only bumps to -SNAPSHOT
              ...(release.type === "maven" ? { "skip-snapshot": true } : {}),
              // release-please's php strategy shows chore commits, which makes each one releasable on its own
              ...(release.type === "php" ? { "changelog-sections": PHP_CHANGELOG_SECTIONS } : {}),
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
        content: json({ [packagePath]: seed }),
      },
      ...localWorkflows(ctx, "release", ["release-please.yml"]),
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
            run: APPROVE_HELD_PR_RUNS,
          },
        ],
      }),
    ];
  },
};
