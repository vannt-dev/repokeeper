import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { printWarnings } from "../src/commands/report.js";
import { parseConfig, renderConfig } from "../src/config/load.js";
import type { Output } from "../src/model.js";
import { MODULES } from "../src/modules/index.js";
import { workflowLintModule } from "../src/modules/workflow-lint.js";
import { planOutputs } from "../src/plan.js";
import { listWorkflows, readWorkflow } from "../src/templates.js";
import { WORKFLOW_REF } from "../src/version.js";
import { capture, gitlabContext, makeContext, syncOnce, tempDir } from "./helpers.js";

const PATH = ".github/workflows/workflow-lint.yml";
const ZIZMOR = ".github/zizmor.yml";
const REUSABLE = ".github/workflows/workflow-lint.yml";
const keys = (outputs: Output[], path = PATH) =>
  Object.fromEntries(
    outputs.flatMap((o) => (o.kind === "yaml" && o.path === path ? [[o.keyPath.join("."), o.value]] : [])),
  );
const on = (overrides: Parameters<typeof makeContext>[0] = {}) =>
  makeContext({ ...overrides, modules: { workflow_lint: true, ...overrides.modules } });

describe("workflow lint module", () => {
  it("is off unless asked for, and round-trips through the configuration file", () => {
    expect(makeContext().config.modules.workflow_lint).toBe(false);
    expect(workflowLintModule.enabled(makeContext().config)).toBe(false);
    expect(planOutputs(makeContext()).some((output) => output.module === "workflow_lint")).toBe(false);
    // a file without the line is one every earlier repokeeper reads as well
    expect(renderConfig(makeContext().config)).not.toContain("workflow_lint");

    expect(workflowLintModule.enabled(on().config)).toBe(true);
    expect(parseConfig(renderConfig(on().config)).modules.workflow_lint).toBe(true);
    expect(MODULES).toContain(workflowLintModule);
  });

  it("calls the reusable workflow when workflows change, on the default branch and weekly", () => {
    const outputs = workflowLintModule.outputs(on());
    expect(new Set(outputs.map((output) => output.path))).toEqual(new Set([PATH, ZIZMOR]));
    expect(outputs.every((output) => output.module === "workflow_lint")).toBe(true);

    const out = keys(outputs);
    expect(out.name).toBe("workflow lint");
    const paths = [".github/**", "**/action.yml", "**/action.yaml"];
    expect(out.on).toEqual({
      pull_request: { paths },
      push: { branches: ["main"], paths },
      schedule: [{ cron: "17 5 * * 1" }],
    });
    expect(out.permissions).toEqual({ contents: "read" });
    expect(out["jobs.lint"]).toEqual({
      uses: `vannt-dev/repokeeper/.github/workflows/workflow-lint.yml@${WORKFLOW_REF}`,
      permissions: { contents: "read" },
    });
  });

  it("follows the default branch", () => {
    const out = keys(workflowLintModule.outputs(on({ config: { github: { default_branch: "develop" } } })));
    expect((out.on as { push: { branches: string[] } }).push.branches).toEqual(["develop"]);
  });

  it("keeps zizmor quiet only about what repokeeper writes on purpose", () => {
    // the standard preset: deps on, cache cleanup off
    const zizmor = keys(workflowLintModule.outputs(on()), ZIZMOR);
    expect(zizmor).toEqual({
      // the callers follow the v0 tag of the workflow repository
      "rules.unpinned-uses.config.policies.vannt-dev/repokeeper/*": "ref-pin",
      // dependabot.yml is repokeeper's whole; a cooldown is the repository's choice
      "rules.dependabot-cooldown.ignore": ["dependabot.yml"],
    });

    // the cache cleanup's pull_request_target checks nothing out
    const all = keys(workflowLintModule.outputs(on({ modules: { cache_cleanup: true, deps: false } })), ZIZMOR);
    expect(all["rules.dangerous-triggers.ignore"]).toEqual(["cache-cleanup.yml"]);
    expect(all).not.toHaveProperty("rules.dependabot-cooldown.ignore");
  });

  it("follows where the reusable workflows are taken from", () => {
    const mirror = workflowLintModule.outputs(
      on({ config: { github: { workflows: { source: "acme/workflows", ref: "v2" } } } }),
    );
    expect(keys(mirror)["jobs.lint"]).toMatchObject({ uses: "acme/workflows/.github/workflows/workflow-lint.yml@v2" });
    expect(keys(mirror, ZIZMOR)).toHaveProperty(["rules.unpinned-uses.config.policies.acme/workflows/*"], "ref-pin");

    const local = workflowLintModule.outputs(on({ config: { github: { workflows: { source: "local" } } } }));
    // a repository that keeps its own copies gets one of this workflow too, and calls it by path
    expect(local.some((output) => output.kind === "seed" && output.path === REUSABLE)).toBe(true);
    expect(keys(local)["jobs.lint"]).toMatchObject({ uses: `./${REUSABLE}` });
    expect(Object.keys(keys(local, ZIZMOR)).some((key) => key.startsWith("rules.unpinned-uses"))).toBe(false);
    expect(listWorkflows()).toContain("workflow-lint.yml");
  });

  it("writes a zizmor settings file that zizmor can read", async () => {
    const dir = await tempDir();
    await syncOnce(dir, workflowLintModule.outputs(on({ modules: { cache_cleanup: true } })));
    expect(parse(await readFile(join(dir, ZIZMOR), "utf8"))).toEqual({
      rules: {
        "unpinned-uses": { config: { policies: { "vannt-dev/repokeeper/*": "ref-pin" } } },
        "dangerous-triggers": { ignore: ["cache-cleanup.yml"] },
        "dependabot-cooldown": { ignore: ["dependabot.yml"] },
      },
    });
  });

  it("pins the tools the reusable workflow runs", () => {
    const reusable = parse(readWorkflow("workflow-lint.yml"));
    const steps = JSON.stringify(reusable.jobs);
    // actionlint is checked against the checksum of its release
    expect(steps).toMatch(/"VERSION":"\d+\.\d+\.\d+"/);
    expect(steps).toMatch(/"SHA256":"[0-9a-f]{64}"/);
    expect(steps).toContain("sha256sum --check --strict");
    // zizmor-action by commit, and zizmor itself by version
    expect(steps).toMatch(/zizmorcore\/zizmor-action@[0-9a-f]{40}"/);
    expect(reusable.jobs.zizmor.steps[1].with).toMatchObject({
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      "advanced-security": false,
      annotations: true,
    });
    // nothing in either job can push
    expect(reusable.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(reusable.jobs) as { permissions: unknown; steps: { with?: object }[] }[]) {
      expect(job.permissions).toEqual({ contents: "read" });
      expect(job.steps[0]?.with).toEqual({ "persist-credentials": false });
    }
  });

  it("writes nothing on GitLab, and says so", async () => {
    expect(workflowLintModule.outputs(gitlabContext({ modules: { workflow_lint: true } }))).toEqual([]);
    const noted = capture();
    await printWarnings(await tempDir(), gitlabContext({ modules: { workflow_lint: true } }), noted.io);
    expect(noted.out.join("\n")).toContain("note: modules.workflow_lint writes nothing on gitlab");
    const quiet = capture();
    await printWarnings(await tempDir(), on(), quiet.io);
    expect(quiet.out.join("\n")).not.toContain("workflow_lint");
  });
});
