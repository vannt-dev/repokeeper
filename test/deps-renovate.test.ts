import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubSettings } from "../src/commands/github.js";
import { nextSteps } from "../src/commands/report.js";
import { parseConfig, renderConfig } from "../src/config/load.js";
import { depsSettings } from "../src/config/types.js";
import { ConfigError } from "../src/errors.js";
import type { FileOutput, Output } from "../src/model.js";
import { automergeModule } from "../src/modules/automerge.js";
import { depsModule } from "../src/modules/deps.js";
import { planOutputs } from "../src/plan.js";
import type { SyncResult } from "../src/sync/sync.js";
import { gitlabContext, makeContext, nodeResolved, syncOnce, tempDir } from "./helpers.js";

const files = (outputs: Output[]) =>
  Object.fromEntries(outputs.flatMap((o) => (o.kind === "file" ? [[o.path, (o as FileOutput).content]] : [])));

describe("deps: what existing repositories get stays byte for byte the same", () => {
  it("writes the same dependabot.yml for deps: true", () => {
    expect(files(depsModule.outputs(makeContext()))[".github/dependabot.yml"]).toMatchInlineSnapshot(`
      "# Managed by repokeeper (https://github.com/vannt-dev/repokeeper). Edits are reported by \`repokeeper check\`.
      version: 2
      updates:
        - package-ecosystem: npm
          directory: /
          schedule:
            interval: weekly
          groups:
            npm-minor-and-patch:
              update-types:
                - minor
                - patch
          commit-message:
            prefix: chore
            include: scope
          ignore:
            - dependency-name: "@types/node"
              update-types:
                - version-update:semver-major
        - package-ecosystem: github-actions
          directory: /
          schedule:
            interval: weekly
          groups:
            github-actions-minor-and-patch:
              update-types:
                - minor
                - patch
          commit-message:
            prefix: chore
            include: scope
      "
    `);
  });

  it("writes the same dependabot.yml with a pinned workflow ref and stacks in folders", () => {
    const ctx = makeContext({
      config: { github: { workflows: { ref: "v0.5.0" } } },
      stacks: [nodeResolved(), nodeResolved({ id: "python", directory: "api", dependabot: ["pip"] })],
    });
    expect(files(depsModule.outputs(ctx))[".github/dependabot.yml"]).toMatchInlineSnapshot(`
      "# Managed by repokeeper (https://github.com/vannt-dev/repokeeper). Edits are reported by \`repokeeper check\`.
      version: 2
      updates:
        - package-ecosystem: npm
          directory: /
          schedule:
            interval: weekly
          groups:
            npm-minor-and-patch:
              update-types:
                - minor
                - patch
          commit-message:
            prefix: chore
            include: scope
          ignore:
            - dependency-name: "@types/node"
              update-types:
                - version-update:semver-major
        - package-ecosystem: pip
          directory: /api
          schedule:
            interval: weekly
          groups:
            pip-minor-and-patch:
              update-types:
                - minor
                - patch
          commit-message:
            prefix: chore
            include: scope
        - package-ecosystem: github-actions
          directory: /
          schedule:
            interval: weekly
          groups:
            github-actions-minor-and-patch:
              update-types:
                - minor
                - patch
          commit-message:
            prefix: chore
            include: scope
          ignore:
            - dependency-name: vannt-dev/repokeeper*
      "
    `);
  });

  it("writes the same renovate.json on GitLab", () => {
    expect(files(depsModule.outputs(gitlabContext()))["renovate.json"]).toMatchInlineSnapshot(`
      "{
        "$schema": "https://docs.renovatebot.com/renovate-schema.json",
        "extends": [
          "config:recommended",
          ":semanticCommits",
          ":semanticCommitTypeAll(chore)"
        ],
        "packageRules": [
          {
            "matchUpdateTypes": [
              "minor",
              "patch"
            ],
            "groupName": "minor and patch updates"
          },
          {
            "matchPackageNames": [
              "@types/node"
            ],
            "matchUpdateTypes": [
              "major"
            ],
            "enabled": false
          },
          {
            "matchManagers": [
              "gitlabci"
            ],
            "matchFileNames": [
              ".gitlab-ci.yml"
            ],
            "matchPackageNames": [
              "node",
              "renovate/renovate",
              "mcr.microsoft.com/dotnet/sdk",
              "hadolint/hadolint"
            ],
            "enabled": false
          }
        ]
      }
      "
    `);
  });
});

const renovate = (overrides: Parameters<typeof makeContext>[0] = {}) =>
  makeContext({ ...overrides, modules: { deps: { tool: "renovate" }, ...overrides.modules } });
const renovateConfig = (ctx: ReturnType<typeof makeContext>) =>
  JSON.parse(files(depsModule.outputs(ctx))["renovate.json"] as string);
const BASE_PRESETS = ["config:recommended", ":semanticCommits", ":semanticCommitTypeAll(chore)"];
const BASE_RULES = [
  { matchUpdateTypes: ["minor", "patch"], groupName: "minor and patch updates" },
  { matchPackageNames: ["@types/node"], matchUpdateTypes: ["major"], enabled: false },
];

describe("deps: Renovate on GitHub", () => {
  it("writes renovate.json with the GitLab rules and no dependabot.yml", () => {
    expect(depsModule.outputs(renovate()).map((output) => output.path)).toEqual(["renovate.json"]);
    expect(renovateConfig(renovate())).toEqual({
      $schema: "https://docs.renovatebot.com/renovate-schema.json",
      extends: BASE_PRESETS,
      packageRules: BASE_RULES,
    });
    // no CI job and no Dependabot file: on GitHub Renovate runs as the Mend app
    const paths = planOutputs(renovate()).map((output) => output.path);
    expect(paths).not.toContain(".github/dependabot.yml");
    expect(paths.filter((path) => path.includes("renovate"))).toEqual(["renovate.json"]);
  });

  it("shares every rule with GitLab but the one for the versions repokeeper names", () => {
    const github = renovateConfig(renovate());
    const gitlab = renovateConfig(gitlabContext());
    expect(gitlab.extends).toEqual(github.extends);
    expect(gitlab.packageRules.slice(0, -1)).toEqual(github.packageRules);
    expect(gitlab.packageRules.at(-1).matchManagers).toEqual(["gitlabci"]);
  });

  it("leaves a pinned workflow reference to repokeeper, as dependabot.yml does", () => {
    const config = renovateConfig(renovate({ config: { github: { workflows: { ref: "v0.5.0" } } } }));
    const rule = config.packageRules.at(-1);
    expect(rule).toEqual({
      matchManagers: ["github-actions"],
      matchPackageNames: ["/^vannt-dev/repokeeper(/|$)/"],
      enabled: false,
    });
    // Renovate reads /…/ as a regular expression; it matches the repository and the files in it only
    const pattern = new RegExp(rule.matchPackageNames[0].slice(1, -1));
    expect(pattern.test("vannt-dev/repokeeper")).toBe(true);
    expect(pattern.test("vannt-dev/repokeeper/.github/workflows/stack-node.yml")).toBe(true);
    expect(pattern.test("vannt-dev/repokeeper-other")).toBe(false);

    const mirror = renovate({ config: { github: { workflows: { source: "acme/ci.workflows", ref: "v3" } } } });
    expect(renovateConfig(mirror).packageRules.at(-1).matchPackageNames).toEqual(["/^acme/ci\\.workflows(/|$)/"]);
    // an unpinned reference is the workflow repository's to move, as with Dependabot
    const unpinned = renovate({ config: { github: { workflows: { source: "acme/ci" } } } });
    expect(renovateConfig(unpinned).packageRules).toEqual(BASE_RULES);
  });

  it("appends the presets of modules.deps.extends on both platforms", () => {
    const presets = ["github>acme/renovate-config", "local>acme/presets:node"];
    const github = renovate({ modules: { deps: { tool: "renovate", extends: presets } } });
    expect(renovateConfig(github).extends).toEqual([...BASE_PRESETS, ...presets]);
    const gitlab = gitlabContext({ modules: { deps: { extends: presets } } });
    expect(renovateConfig(gitlab).extends).toEqual([...BASE_PRESETS, ...presets]);
    // nothing else of GitLab's moves
    expect({ ...renovateConfig(gitlab), extends: BASE_PRESETS }).toEqual(renovateConfig(gitlabContext()));
  });

  it("keeps the zizmor exception for dependabot.yml to Dependabot", () => {
    const cooldown = (ctx: ReturnType<typeof makeContext>) =>
      planOutputs(ctx).filter(
        (o) => o.kind === "yaml" && o.path === ".github/zizmor.yml" && o.keyPath[1] === "dependabot-cooldown",
      );
    expect(cooldown(makeContext({ modules: { workflow_lint: true } }))).toHaveLength(1);
    expect(cooldown(renovate({ modules: { workflow_lint: true } }))).toHaveLength(0);
  });
});

describe("deps: auto-merge with Renovate", () => {
  it("writes Renovate's own automerge for the minor and patch group instead of the workflow", () => {
    const ctx = renovate({ modules: { automerge: true } });
    expect(renovateConfig(ctx).packageRules).toEqual([{ ...BASE_RULES[0], automerge: true }, BASE_RULES[1]]);
    expect(automergeModule.outputs(ctx)).toEqual([]);
    // nor a copy of the Dependabot workflow, for a repository that keeps its own
    const local = renovate({ modules: { automerge: true }, config: { github: { workflows: { source: "local" } } } });
    expect(planOutputs(local).some((output) => output.path.includes("automerge"))).toBe(false);
    // github apply still allows auto-merge, which Renovate turns on for its pull requests
    expect(githubSettings(ctx.config).merge?.auto_merge).toBe(true);
  });

  it("leaves Dependabot's workflow and GitLab's renovate.json as they were", () => {
    const dependabot = makeContext({ modules: { automerge: true } });
    expect(automergeModule.outputs(dependabot).some((o) => o.path === ".github/workflows/automerge.yml")).toBe(true);
    expect(renovateConfig(gitlabContext({ modules: { automerge: true } }))).toEqual(renovateConfig(gitlabContext()));
  });

  it("says to install the Renovate app, and to allow auto-merge when the module is on", async () => {
    const result = (action: string) =>
      ({
        decisions: [{ output: { kind: "file", path: "renovate.json" }, action }],
        removals: [],
      }) as unknown as SyncResult;
    const app =
      "install the Mend Renovate GitHub App (https://github.com/apps/renovate) on this repository; it reads renovate.json and opens the dependency updates";
    const allow =
      "run `repokeeper github apply` to allow auto-merge; Renovate then merges its patch and minor updates once their checks have passed";
    const automerge = renovate({ modules: { automerge: true } });
    // the formatter step of the node stack is not what this is about
    const steps = async (...args: Parameters<typeof nextSteps>) =>
      (await nextSteps(...args)).filter((step) => step.includes("Renovate"));
    expect(await steps(".", renovate(), result("create"))).toEqual([app]);
    expect(await steps(".", automerge, result("create"))).toEqual([app, allow]);
    // switched on later: renovate.json is rewritten, and the app is already there
    expect(await steps(".", automerge, result("write"))).toEqual([allow]);
    expect(await steps(".", renovate(), result("unchanged"))).toEqual([]);
    // GitLab runs Renovate from its own job
    expect(await steps(".", gitlabContext(), result("create"))).toEqual([]);
  });
});

describe("deps: switching tools", () => {
  it("removes the dependabot.yml repokeeper wrote, and keeps one that was edited", async () => {
    const dir = await tempDir();
    const dependabot = join(dir, ".github/dependabot.yml");
    const removals = (result: SyncResult) => result.removals.map((r) => [r.entry.target.path, r.action]);
    await syncOnce(dir, depsModule.outputs(makeContext()));
    expect(existsSync(dependabot)).toBe(true);

    const switched = await syncOnce(dir, depsModule.outputs(renovate()));
    expect(removals(switched)).toEqual([[".github/dependabot.yml", "delete"]]);
    expect(existsSync(dependabot)).toBe(false);
    expect(existsSync(join(dir, "renovate.json"))).toBe(true);

    // and back, then over again with the file edited by hand in between
    await syncOnce(dir, depsModule.outputs(makeContext()));
    expect(existsSync(join(dir, "renovate.json"))).toBe(false);
    await writeFile(dependabot, "# mine\nversion: 2\nupdates: []\n");
    const edited = await syncOnce(dir, depsModule.outputs(renovate()));
    expect(removals(edited)).toEqual([[".github/dependabot.yml", "orphan-edited"]]);
    expect(existsSync(dependabot)).toBe(true);
  });
});

describe("deps: configuration", () => {
  const parse = (platform: string, deps: string) =>
    parseConfig(
      `schema: 1\nstandard: 1.0.0\nstacks: [node]\nplatform: ${platform}\nmodules:\n  health: false\n  deps: ${deps}\n`,
    );
  const errorOf = (platform: string, deps: string) => {
    try {
      parse(platform, deps);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    }
    throw new Error("expected a ConfigError");
  };

  it("takes true, false or a mapping, and keeps what was written", () => {
    expect(depsSettings(parse("github", "true"))).toEqual({ tool: "dependabot", extends: [] });
    expect(depsSettings(parse("github", "false"))).toBeNull();
    expect(depsSettings(parse("github", "{}"))).toEqual({ tool: "dependabot", extends: [] });
    expect(depsSettings(parse("gitlab", "true"))).toEqual({ tool: "renovate", extends: [] });
    const mapping = parse("github", '{ tool: renovate, extends: ["github>acme/renovate-config"] }');
    expect(depsSettings(mapping)).toEqual({ tool: "renovate", extends: ["github>acme/renovate-config"] });
    expect(mapping.modules.deps).toEqual({ tool: "renovate", extends: ["github>acme/renovate-config"] });
    expect(parseConfig(renderConfig(mapping))).toEqual(mapping);
    expect(depsSettings(parse("gitlab", '{ extends: ["github>acme/x"] }'))).toEqual({
      tool: "renovate",
      extends: ["github>acme/x"],
    });
  });

  it("refuses a tool it does not know, a bad list and Dependabot where it cannot run", () => {
    expect(errorOf("github", "{ tool: snyk }")).toMatch(/modules\.deps/);
    expect(errorOf("github", '{ tool: renovate, extends: "github>acme/x" }')).toMatch(/modules\.deps/);
    expect(errorOf("github", "{ tool: renovate, extends: [x, x] }")).toMatch(/modules\.deps/);
    expect(errorOf("github", '{ tool: renovate, extends: [""] }')).toMatch(/modules\.deps/);
    expect(errorOf("github", "{ tool: renovate, schedule: weekly }")).toMatch(/modules\.deps/);
    expect(errorOf("github", "dependabot")).toMatch(/modules\.deps/);
    expect(errorOf("github", '{ extends: ["github>acme/x"] }')).toBe(
      ".repokeeper.yml:7: modules.deps.extends lists Renovate presets; add tool: renovate to use them",
    );
    expect(errorOf("gitlab", "{ tool: dependabot }")).toBe(
      ".repokeeper.yml:7: modules.deps.tool: Dependabot runs on GitHub only; GitLab uses renovate",
    );
  });
});
