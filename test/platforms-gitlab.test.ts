import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildContext } from "../src/commands/context.js";
import { printWarnings } from "../src/commands/report.js";
import { parseConfig } from "../src/config/load.js";
import type { Output } from "../src/model.js";
import { ciModule } from "../src/modules/ci.js";
import { depsModule } from "../src/modules/deps.js";
import { healthModule } from "../src/modules/health.js";
import { releaseModule } from "../src/modules/release.js";
import { planOutputs } from "../src/plan.js";
import { githubPlatform } from "../src/platforms/github.js";
import { platformFor } from "../src/platforms/index.js";
import { PACKAGE_VERSION, TOOL_VERSIONS } from "../src/version.js";
import { capture, gitlabContext, makeContext, nodeResolved, syncOnce, tempDir } from "./helpers.js";

const files = (outputs: Output[]) =>
  Object.fromEntries(outputs.flatMap((o) => (o.kind === "file" ? [[o.path, o.content]] : [])));
const keys = (outputs: Output[]) =>
  Object.fromEntries(outputs.flatMap((o) => (o.kind === "yaml" ? [[o.keyPath.join("."), o.value]] : [])));
const NOT_SCHEDULED = [
  {
    if: '$CI_PIPELINE_SOURCE != "schedule" && $CI_COMMIT_TAG == null && ($CI_COMMIT_BRANCH == null || $CI_COMMIT_MESSAGE !~ /^chore\\(release\\): /)',
  },
];

describe("gitlab community files", () => {
  it("writes issue and merge request templates and CODEOWNERS under .gitlab", () => {
    const out = files(healthModule.outputs(gitlabContext()));
    expect(out[".gitlab/issue_templates/Bug.md"]).toContain("## What happened?");
    expect(out[".gitlab/issue_templates/Bug.md"]).toMatch(/\n\/label ~bug\n$/);
    expect(out[".gitlab/issue_templates/Feature.md"]).toContain("## What problem would this solve?");
    expect(out[".gitlab/issue_templates/Feature.md"]).toMatch(/\n\/label ~enhancement\n$/);
    expect(out[".gitlab/merge_request_templates/Default.md"]).toContain("- [ ] Tests added or updated");
    expect(out[".gitlab/CODEOWNERS"]).toMatch(/\n\* @vannt-dev\n$/);
    expect(Object.keys(out).some((path) => path.startsWith(".github/"))).toBe(false);
  });

  it("leaves CODEOWNERS out without owners", () => {
    const health = { license: "MIT", copyright: "2026 Demo", contact: "x", codeowners: [] };
    const out = files(healthModule.outputs(gitlabContext({ modules: { health } })));
    expect(out[".gitlab/CODEOWNERS"]).toBeUndefined();
  });
});

describe("platform wording", () => {
  it("asks for a confidential issue and a merge request on gitlab", () => {
    const out = files(healthModule.outputs(gitlabContext()));
    expect(out["SECURITY.md"]).toContain(
      "by opening a [confidential issue](https://gitlab.com/acme/tools/example/-/issues/new?issue%5Bconfidential%5D=true)",
    );
    expect(out["SECURITY.md"]).not.toContain("advisories");
    expect(out["CONTRIBUTING.md"]).toContain("3. Open a merge request.");
  });

  it("uses the remote's host on a self-hosted GitLab", () => {
    const repo = { host: "git.example.org", owner: "acme", name: "example" };
    expect(files(healthModule.outputs(gitlabContext({ repo })))["SECURITY.md"]).toContain(
      "https://git.example.org/acme/example/-/issues/new",
    );
    expect(platformFor("gitlab").profileUrl(repo)).toBe("https://git.example.org/acme");
  });

  it("falls back to plain wording without a remote", () => {
    const repo = { owner: null, name: "example" };
    expect(files(healthModule.outputs(gitlabContext({ repo })))["SECURITY.md"]).toContain(
      "by opening a confidential issue in the repository",
    );
    expect(platformFor("gitlab").profileUrl(repo)).toBeNull();
  });

  it("keeps the GitHub wording", () => {
    const out = files(healthModule.outputs(makeContext()));
    expect(out["CONTRIBUTING.md"]).toContain("3. Open a pull request.");
    expect(githubPlatform.profileUrl({ owner: "vannt-dev", name: "example" })).toBe("https://github.com/vannt-dev");
    expect(githubPlatform.profileUrl({ owner: null, name: "example" })).toBeNull();
  });
});

describe("platform selection", () => {
  const config = (platform: string, stack: string) =>
    parseConfig(`schema: 1\nstandard: 1.0.0\nplatform: ${platform}\nstacks: [${stack}]\nmodules:\n  health: false\n`);

  it("builds the context with the configured platform's adapter", async () => {
    const root = await tempDir();
    await writeFile(join(root, "package.json"), "{}\n");
    expect((await buildContext(root, config("gitlab", "node"))).platform.id).toBe("gitlab");
    expect((await buildContext(root, config("github", "node"))).platform.id).toBe("github");
  });

  it("has every stack on both platforms", () => {
    expect(platformFor("gitlab").stacks).toEqual(platformFor("github").stacks);
  });
});

describe("gitlab ci", () => {
  it("runs for merge requests, schedules, the default branch and tags", () => {
    const outputs = ciModule.outputs(gitlabContext());
    expect(outputs.every((o) => o.kind === "yaml" && o.path === ".gitlab-ci.yml" && o.module === "ci")).toBe(true);
    expect(keys(outputs).workflow).toEqual({
      rules: [
        { if: '$CI_PIPELINE_SOURCE == "merge_request_event"' },
        { if: '$CI_PIPELINE_SOURCE == "schedule"' },
        { if: '$CI_COMMIT_BRANCH == "main"' },
        { if: "$CI_COMMIT_TAG" },
      ],
    });
    expect(keys(outputs).stages).toBeUndefined();
    const trunk = keys(ciModule.outputs(gitlabContext({ config: { gitlab: { default_branch: "trunk" } } })));
    expect(trunk.workflow).toMatchObject({ rules: expect.arrayContaining([{ if: '$CI_COMMIT_BRANCH == "trunk"' }]) });
  });

  it("runs the node scripts on every configured version with the npm cache", () => {
    expect(keys(ciModule.outputs(gitlabContext())).node).toEqual({
      stage: "test",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
      image: "node:${NODE_VERSION}",
      parallel: { matrix: [{ NODE_VERSION: ["22", "24"] }] },
      rules: NOT_SCHEDULED,
      variables: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_cache: "$CI_PROJECT_DIR/.npm" },
      cache: { key: { files: ["package-lock.json"] }, paths: [".npm/"] },
      script: ["npm ci", "npm run test"],
    });
  });

  it("enables corepack for pnpm and yarn and skips the npm cache", () => {
    const stack = nodeResolved({
      ci: {
        workflow: "stack-node.yml",
        with: {
          "node-versions": '["20"]',
          os: '["ubuntu-latest"]',
          "package-manager": "pnpm",
          "install-command": "pnpm install --frozen-lockfile",
          cache: "",
          scripts: '["lint","test:e2e"]',
        },
      },
    });
    const node = keys(ciModule.outputs(gitlabContext({ stacks: [stack] }))).node as Record<string, unknown>;
    expect(node.parallel).toEqual({ matrix: [{ NODE_VERSION: ["20"] }] });
    expect(node.script).toEqual([
      "corepack enable",
      "pnpm install --frozen-lockfile",
      "pnpm run lint",
      "pnpm run test:e2e",
    ]);
    expect(node.cache).toBeUndefined();
    expect(node.variables).toEqual({ COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" });
  });

  it("lints up to the source branch head, also in a merged results pipeline", () => {
    const commits = keys(ciModule.outputs(gitlabContext())).commits as { script: string[]; variables: unknown };
    expect(commits).toMatchObject({ stage: "test", image: "node:24", rules: NOT_SCHEDULED });
    expect(commits.variables).toEqual({ GIT_DEPTH: "0" });
    const script = commits.script.join("\n");
    expect(script).toContain("@commitlint/cli@21.2.3 @commitlint/config-conventional@21.2.3");
    expect(script).toContain('head="$CI_MERGE_REQUEST_SOURCE_BRANCH_SHA"');
    expect(script).toContain('[ -n "$head" ] || head="$CI_COMMIT_SHA"');
    expect(script).toContain('lint --from "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --to "$head"');
    expect(script).toContain("lint --last");
  });

  it("adds the drift job only when asked, and drops the commits job with its module", () => {
    expect(keys(ciModule.outputs(gitlabContext())).repokeeper).toBeUndefined();
    const out = keys(ciModule.outputs(gitlabContext({ modules: { drift: true, commits: false } })));
    expect(out.repokeeper).toEqual({
      stage: "test",
      image: "node:24",
      rules: NOT_SCHEDULED,
      script: [`npx --yes repokeeper@${PACKAGE_VERSION} check`],
    });
    expect(out.commits).toBeUndefined();
  });

  it("writes nothing when no job would run", () => {
    const ctx = gitlabContext({ stacks: [nodeResolved({ ci: null })], modules: { commits: false } });
    expect(ciModule.outputs(ctx)).toEqual([]);
  });

  it("keeps the user's own jobs and stays unchanged on the next sync", async () => {
    const root = await tempDir();
    await writeFile(join(root, ".gitlab-ci.yml"), "docs:\n  script:\n    - make docs\n");
    const outputs = ciModule.outputs(gitlabContext());

    await syncOnce(root, outputs);
    const written = parse(await readFile(join(root, ".gitlab-ci.yml"), "utf8"));
    expect(written.docs).toEqual({ script: ["make docs"] });
    expect(Object.keys(written)).toEqual(["workflow", "node", "commits", "docs"]);
    expect(written.node.script).toEqual(["npm ci", "npm run test"]);
    expect((await syncOnce(root, outputs)).decisions.map((d) => d.action)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
  });

  it("notes that node.os has no effect on gitlab", async () => {
    const root = await tempDir();
    const windows = nodeResolved();
    (windows.ci as { with: Record<string, string> }).with.os = '["ubuntu-latest","windows-latest"]';

    const noted = capture(root);
    await printWarnings(root, gitlabContext({ stacks: [windows] }), noted.io);
    expect(noted.out).toContain("note: node.os is ignored on gitlab (Linux runners only)");

    const quiet = capture(root);
    await printWarnings(root, gitlabContext(), quiet.io);
    await printWarnings(root, makeContext({ stacks: [windows] }), quiet.io);
    expect(quiet.out.join("\n")).not.toContain("node.os");
  });
});

describe("gitlab release", () => {
  it("configures semantic-release for the default branch without publishing", () => {
    const outputs = releaseModule.outputs(gitlabContext({ config: { gitlab: { default_branch: "trunk" } } }));
    const config = JSON.parse(files(outputs)[".releaserc.json"] as string);
    expect(config.branches).toEqual(["trunk"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a semantic-release template
    expect(config.tagFormat).toBe("v${version}");
    expect(config.plugins).toEqual([
      ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
      ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
      ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
      ["@semantic-release/npm", { npmPublish: false }],
      [
        "@semantic-release/git",
        {
          assets: ["CHANGELOG.md", "package.json", "package-lock.json", "npm-shrinkwrap.json"],
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a semantic-release template
          message: "chore(release): ${nextRelease.version}",
        },
      ],
      "@semantic-release/gitlab",
    ]);
    expect(files(outputs)["release-please-config.json"]).toBeUndefined();
    expect(outputs.some((o) => o.kind === "seed" || o.kind === "marker")).toBe(false);
  });

  it("releases from the default branch only when GITLAB_TOKEN is set", () => {
    const release = keys(releaseModule.outputs(gitlabContext())).release as { script: string[] };
    expect(release).toMatchObject({
      stage: "deploy",
      image: "node:24",
      rules: [
        {
          if: '$CI_PIPELINE_SOURCE != "schedule" && $CI_COMMIT_BRANCH == "main" && $GITLAB_TOKEN && ($CI_COMMIT_BRANCH == null || $CI_COMMIT_MESSAGE !~ /^chore\\(release\\): /)',
        },
      ],
      variables: { GIT_DEPTH: "0" },
    });
    const script = release.script.join("\n");
    expect(script).toContain(
      "semantic-release@25.0.9 @semantic-release/changelog@7.0.0 @semantic-release/git@11.0.1 @semantic-release/gitlab@13.3.3 conventional-changelog-conventionalcommits@9.3.1",
    );
    expect(script).toContain('"$dir/node_modules/.bin/semantic-release"');
  });
});

describe("gitlab dependency updates", () => {
  it("configures Renovate with chore commits, one minor and patch group and no @types/node majors", () => {
    const config = JSON.parse(files(depsModule.outputs(gitlabContext()))["renovate.json"] as string);
    expect(config).toEqual({
      $schema: "https://docs.renovatebot.com/renovate-schema.json",
      extends: ["config:recommended", ":semanticCommits", ":semanticCommitTypeAll(chore)"],
      packageRules: [
        { matchUpdateTypes: ["minor", "patch"], groupName: "minor and patch updates" },
        { matchPackageNames: ["@types/node"], matchUpdateTypes: ["major"], enabled: false },
        {
          matchManagers: ["gitlabci"],
          matchFileNames: [".gitlab-ci.yml"],
          matchPackageNames: ["node", "renovate/renovate", "mcr.microsoft.com/dotnet/sdk"],
          enabled: false,
        },
      ],
    });
    expect(files(depsModule.outputs(gitlabContext()))[".github/dependabot.yml"]).toBeUndefined();
  });

  it("runs Renovate only in scheduled pipelines with RENOVATE_TOKEN", () => {
    expect(keys(depsModule.outputs(gitlabContext())).renovate).toEqual({
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
    });
  });
});

describe("gitlab plan", () => {
  it("release and renovate jobs stand alone when the ci module is off", () => {
    const outputs = planOutputs(gitlabContext({ modules: { ci: false } }));
    const out = keys(outputs);
    expect(Object.keys(out).sort()).toEqual(["release", "renovate"]);
    for (const job of [out.release, out.renovate] as { stage: string; rules: unknown[]; script: string[] }[]) {
      expect(["test", "deploy"]).toContain(job.stage);
      expect(job.rules.length).toBe(1);
      expect(job.script.length).toBeGreaterThan(0);
    }
  });

  it("plans every module together without two outputs for one key", () => {
    const outputs = planOutputs(gitlabContext({ modules: { drift: true } }));
    expect(Object.keys(keys(outputs)).sort()).toEqual([
      "commits",
      "node",
      "release",
      "renovate",
      "repokeeper",
      "workflow",
    ]);
    expect(outputs.some((o) => o.path.startsWith(".github/") || o.path.startsWith("release-please"))).toBe(false);
  });
});

describe("gitlab warnings", () => {
  it("warns when the user's stages leave out the ones the managed jobs use", async () => {
    const root = await tempDir();
    await writeFile(join(root, ".gitlab-ci.yml"), "stages:\n  - build\n  - test\n");
    const missing = capture(root);
    await printWarnings(root, gitlabContext(), missing.io);
    expect(missing.out).toContain(
      "warning: .gitlab-ci.yml: stages lacks deploy, which repokeeper's jobs use; add it, or GitLab rejects the pipeline",
    );

    await writeFile(join(root, ".gitlab-ci.yml"), "stages: [build, test, deploy]\n");
    const complete = capture(root);
    await printWarnings(root, gitlabContext(), complete.io);
    await printWarnings(await tempDir(), gitlabContext(), complete.io);
    expect(complete.out.join("\n")).not.toContain("stages");
  });
});
