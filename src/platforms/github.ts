import { stringify } from "yaml";
import { CONFIG_FILE } from "../config/load.js";
import { defaultBranch, STACK_IDS, type StackId } from "../config/types.js";
import { ConfigError } from "../errors.js";
import { globsToRegex } from "../glob.js";
import {
  type DependencyUpdate,
  MANAGED_HEADER,
  type ModuleContext,
  type Output,
  type PlatformAdapter,
  type ReleaseInfo,
  type ResolvedStack,
} from "../model.js";
import type { Registry } from "../modules/publish.js";
import { readWorkflow } from "../templates.js";
import {
  ACTION_PINS,
  EXACT_WORKFLOW_REF,
  PACKAGE_VERSION,
  REUSABLE_REPO,
  TOOL_VERSIONS,
  WORKFLOW_REF,
} from "../version.js";

const pinned = (pin: (typeof ACTION_PINS)[keyof typeof ACTION_PINS]) => `${pin.action}@${pin.sha}`;

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

/** A key of zizmor's settings, which it reads from .github/zizmor.yml. */
const zizmorKey = (keyPath: string[], value: unknown): Output => ({
  kind: "yaml",
  module: "workflow_lint",
  path: ".github/zizmor.yml",
  keyPath,
  value,
});

/** Waits briefly for the held runs to appear, since GitHub creates them just after the pull request event. */
const APPROVE_HELD_PR_RUNS = `for _ in 1 2 3 4 5 6; do
  ids=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs?branch=$BRANCH&event=pull_request&status=action_required" --jq '.workflow_runs[].id')
  [ -n "$ids" ] && break
  sleep 10
done
if [ -z "$ids" ]; then echo "::notice::no held runs for $BRANCH"; fi
for id in $ids; do gh api -X POST "repos/$GITHUB_REPOSITORY/actions/runs/$id/approve"; done
`;

/**
 * Deletes the Actions caches nothing will read again. With a pull request number (the pull request has
 * closed): that pull request's caches, which only it could read. Without (the weekly sweep): the caches of
 * every closed pull request, and on each branch, per kind of cache (its key without the trailing hash),
 * the copies left unused for a day longer than the newest one. GitHub itself drops them only after 7 days.
 */
const CACHE_CLEANUP = String.raw`set -euo pipefail
gh api --paginate "repos/$GH_REPO/actions/caches?per_page=100" --jq '.actions_caches[]' > caches.json
if [ -n "$PR_NUMBER" ]; then
  open='[]'
  filter='map(select(.ref == "refs/pull/'"$PR_NUMBER"'/merge"))'
else
  open=$(gh pr list --state open --limit 500 --json number --jq '[.[] | "refs/pull/\(.number)/merge"]')
  # shellcheck disable=SC2016 # a jq program: its $ names are jq's, not the shell's
  filter='
    def t: .last_accessed_at[0:19] + "Z" | fromdateiso8601;
    def kind: .key | sub("[-_|][0-9a-f]{12,}.*$"; "");
    map(select(.ref | startswith("refs/pull/")) | select(.ref as $r | $open | index($r) | not))
    + (map(select(.ref | startswith("refs/pull/") | not))
       | group_by([.ref, kind])
       | map((map(t) | max) as $newest | map(select(t < $newest - 86400)))
       | add // [])'
fi
jq -rs --argjson open "$open" "$filter | .[] | [.id, .size_in_bytes, .ref, .key] | @tsv" caches.json > delete.tsv
deleted=0; bytes=0
while IFS=$'\t' read -r id size ref key; do
  if gh api -X DELETE "repos/$GH_REPO/actions/caches/$id" > /dev/null; then
    echo "deleted $ref $key"
    deleted=$((deleted + 1)); bytes=$((bytes + size))
  fi
done < delete.tsv
echo "### Deleted $deleted caches, $((bytes / 1048576)) MB" >> "$GITHUB_STEP_SUMMARY"
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
    const skipWhenOnly = ctx.config.github?.ci?.skip_when_only;
    const gated = skipWhenOnly !== undefined && ctx.stacks.some((stack) => stack.ci);
    if (gated) {
      jobs.push(workflowKey("ci", path, ["jobs", "changes"], changesJob(skipWhenOnly)));
    }
    for (const stack of ctx.stacks) {
      if (stack.ci) {
        jobs.push(
          workflowKey("ci", path, ["jobs", stack.id], {
            ...(gated ? { needs: "changes", if: SKIP_DOCS_ONLY } : {}),
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

  cacheCleanup(): Output[] {
    const path = ".github/workflows/cache-cleanup.yml";
    return [
      workflowKey("cache_cleanup", path, ["name"], "cache cleanup"),
      workflowKey("cache_cleanup", path, ["on"], {
        // not pull_request: a pull request from a fork would get a token that cannot delete caches
        pull_request_target: { types: ["closed"] },
        // also catches the pull requests that closed before the workflow existed
        schedule: [{ cron: "23 3 * * 0" }],
        workflow_dispatch: null,
      }),
      // nothing is checked out: the job reads only the pull request number
      workflowKey("cache_cleanup", path, ["permissions"], {
        actions: "write",
        contents: "read",
        "pull-requests": "read",
      }),
      workflowKey("cache_cleanup", path, ["jobs", "cleanup"], {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 10,
        steps: [
          {
            name: "Delete caches nothing will read again",
            env: {
              // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
              GH_TOKEN: "${{ github.token }}",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
              GH_REPO: "${{ github.repository }}",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
              PR_NUMBER: "${{ github.event.pull_request.number }}",
            },
            run: CACHE_CLEANUP,
          },
        ],
      }),
    ];
  },

  dependencyAutomerge(ctx: ModuleContext): Output[] {
    // not the name of the reusable workflow it calls: a repository that keeps its own copies has both
    const path = ".github/workflows/automerge.yml";
    return [
      ...localWorkflows(ctx, "automerge", ["dependabot-automerge.yml"]),
      workflowKey("automerge", path, ["name"], "automerge"),
      workflowKey("automerge", path, ["on"], { pull_request: null }),
      workflowKey("automerge", path, ["permissions"], { contents: "read" }),
      workflowKey("automerge", path, ["jobs", "automerge"], {
        uses: workflowRef(ctx, "dependabot-automerge.yml"),
        // what the called job asks for; a run that Dependabot starts has a read-only token without it
        permissions: { contents: "write", "pull-requests": "write" },
        with: { "merge-method": mergeMethod(ctx) },
        // a Dependabot secret: a run that Dependabot starts sees no Actions secret
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
        secrets: { token: "${{ secrets.AUTOMERGE_TOKEN }}" },
      }),
    ];
  },

  workflowLint(ctx: ModuleContext): Output[] {
    // not the name of the reusable workflow it calls: a repository that keeps its own copies has both
    const path = ".github/workflows/workflow-lint.yml";
    // workflows, Dependabot's file, zizmor's own settings and composite actions; a list of its own for each
    // trigger, or the YAML would share one through an anchor
    const paths = () => [".github/**", "**/action.yml", "**/action.yaml"];
    const origin = workflowOrigin(ctx);
    return [
      ...localWorkflows(ctx, "workflow_lint", ["workflow-lint.yml"]),
      workflowKey("workflow_lint", path, ["name"], "workflow lint"),
      workflowKey("workflow_lint", path, ["on"], {
        pull_request: { paths: paths() },
        push: { branches: [defaultBranch(ctx.config)], paths: paths() },
        // weekly as well: zizmor's online audits learn of new advisories for actions already in use
        schedule: [{ cron: "17 5 * * 1" }],
      }),
      workflowKey("workflow_lint", path, ["permissions"], { contents: "read" }),
      workflowKey("workflow_lint", path, ["concurrency"], {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
        group: "${{ github.workflow }}-${{ github.ref }}",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
        "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      }),
      workflowKey("workflow_lint", path, ["jobs", "lint"], {
        uses: workflowRef(ctx, "workflow-lint.yml"),
        permissions: { contents: "read" },
      }),
      // What zizmor would report in the files repokeeper writes itself, each kept on purpose
      ...(origin.local
        ? []
        : [
            // the callers follow a tag of the workflow repository (v0), which a release moves on purpose
            zizmorKey(["rules", "unpinned-uses", "config", "policies", `${origin.repo}/*`], "ref-pin"),
          ]),
      ...(ctx.config.modules.cache_cleanup
        ? [
            // pull_request_target with nothing checked out: the job reads only the pull request number
            zizmorKey(["rules", "dangerous-triggers", "ignore"], ["cache-cleanup.yml"]),
          ]
        : []),
      ...(ctx.config.modules.deps
        ? [
            // repokeeper writes the whole file; a cooldown would hold back every version update, a choice
            // it leaves to the repository (security updates are never held back either way)
            zizmorKey(["rules", "dependabot-cooldown", "ignore"], ["dependabot.yml"]),
          ]
        : []),
    ];
  },

  registryPublish(_ctx: ModuleContext, stack: ResolvedStack, registry: Registry): Output[] {
    // A job of release.yml itself, not a reusable workflow: PyPI does not take a reusable workflow as a
    // trusted publisher, and npm checks the name of the calling workflow. Both then name release.yml.
    return [workflowKey("publish", ".github/workflows/release.yml", ["jobs", "publish"], publishJob(stack, registry))];
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

/** The first merge method `github.merge` leaves allowed, squash first; GitHub allows all three by default. */
function mergeMethod(ctx: ModuleContext): "squash" | "merge" | "rebase" {
  const merge = ctx.config.github?.merge ?? {};
  if (merge.squash !== false) return "squash";
  if (merge.merge_commit !== false) return "merge";
  return "rebase";
}

/**
 * The job that publishes a release once release-please has made it. The registry trusts the run through
 * OIDC (`id-token: write`), so no token is stored; npm adds provenance by itself for a public repository.
 */
function publishJob(stack: ResolvedStack, registry: Registry): Record<string, unknown> {
  const checkout = { uses: pinned(ACTION_PINS.checkout), with: { "persist-credentials": false } };
  const common = {
    needs: "release",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    if: "${{ needs.release.outputs.release_created == 'true' }}",
    "runs-on": "ubuntu-latest",
    permissions: { contents: "read", "id-token": "write" },
  };
  if (registry === "pypi") {
    return {
      ...common,
      steps: [
        checkout,
        { uses: pinned(ACTION_PINS.setupPython), with: { "python-version": "3.x" } },
        { name: "Build", run: `python -m pip install build==${TOOL_VERSIONS.pypaBuild} && python -m build` },
        { name: "Publish to PyPI", uses: pinned(ACTION_PINS.pypiPublish) },
      ],
    };
  }
  const manager = stack.ci?.with["package-manager"] ?? "npm";
  return {
    ...common,
    ...(manager !== "npm" ? { env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } } : {}),
    steps: [
      checkout,
      // Node.js 24 comes with an npm new enough (11.5.1 or later) to publish through OIDC
      {
        uses: pinned(ACTION_PINS.setupNode),
        with: { "node-version": "24", "registry-url": "https://registry.npmjs.org" },
      },
      ...(manager !== "npm" ? [{ name: "Enable corepack", run: "corepack enable" }] : []),
      { name: "Install dependencies", run: stack.ci?.with["install-command"] ?? "npm ci" },
      // npm itself, whatever the package manager: it is the client that signs in through OIDC
      { name: "Publish to npm", run: "npm publish --access public" },
    ],
  };
}

// Runs the stack job unless the changes job said "only listed paths". A changes job that failed
// gives no answer, and then the stack job runs: an error never skips the tests.
// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
const SKIP_DOCS_ONLY = "${{ !cancelled() && needs.changes.outputs.code != 'false' }}";

/**
 * The job that tells whether a pull request changes anything outside `globs`. It asks the API for
 * the pull request's files instead of checking out the history, which also works for a fork.
 */
function changesJob(globs: string[]): Record<string, unknown> {
  return {
    "runs-on": "ubuntu-latest",
    permissions: { "pull-requests": "read" },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    outputs: { code: "${{ steps.files.outputs.code }}" },
    steps: [
      {
        id: "files",
        env: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
          GH_TOKEN: "${{ github.token }}",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
          EVENT: "${{ github.event_name }}",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
          PR: "${{ github.event.pull_request.number }}",
        },
        run: [
          "code=true",
          'if [ "$EVENT" = pull_request ] && files=$(gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR/files" --jq \'.[].filename\'); then',
          "  printf '%s\\n' \"$files\"",
          `  if [ -n "$files" ] && ! printf '%s\\n' "$files" | grep -Evq '${globsToRegex(globs)}'; then code=false; fi`,
          "fi",
          'echo "code=$code" >> "$GITHUB_OUTPUT"',
          "",
        ].join("\n"),
      },
    ],
  };
}
