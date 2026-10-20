import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { githubSettings } from "../src/commands/github.js";
import { applyPreset } from "../src/commands/presets.js";
import { nextSteps, printWarnings } from "../src/commands/report.js";
import { parseConfig, renderConfig } from "../src/config/load.js";
import type { ApiResponse, GitHubApi } from "../src/github/api.js";
import { planGithub } from "../src/github/settings.js";
import type { Output } from "../src/model.js";
import { automergeModule } from "../src/modules/automerge.js";
import { MODULES } from "../src/modules/index.js";
import { planOutputs } from "../src/plan.js";
import type { SyncResult } from "../src/sync/sync.js";
import { listWorkflows } from "../src/templates.js";
import { WORKFLOW_REF } from "../src/version.js";
import { capture, gitlabContext, makeContext, tempDir } from "./helpers.js";

const PATH = ".github/workflows/automerge.yml";
const REUSABLE = ".github/workflows/dependabot-automerge.yml";
const keys = (outputs: Output[]) =>
  Object.fromEntries(outputs.flatMap((o) => (o.kind === "yaml" ? [[o.keyPath.join("."), o.value]] : [])));
const on = (overrides: Parameters<typeof makeContext>[0] = {}) =>
  makeContext({ ...overrides, modules: { automerge: true, ...overrides.modules } });
const job = (ctx = on()) => keys(automergeModule.outputs(ctx))["jobs.automerge"] as Record<string, unknown>;
const CONFIG = "schema: 1\nstandard: 1.0.0\nplatform: github\nstacks: [node]\n";

interface Step {
  id?: string;
  if?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
}

describe("automerge module", () => {
  it("is off unless asked for, and round-trips through the configuration file", () => {
    expect(makeContext().config.modules.automerge).toBe(false);
    expect(automergeModule.enabled(makeContext().config)).toBe(false);
    expect(planOutputs(makeContext()).some((output) => output.path === PATH)).toBe(false);
    expect(renderConfig(makeContext().config)).not.toContain("automerge");

    expect(automergeModule.enabled(on().config)).toBe(true);
    expect(parseConfig(renderConfig(on().config)).modules.automerge).toBe(true);
    expect(MODULES).toContain(automergeModule);
  });

  it("is in no preset; under strict the required review still gates the merge", () => {
    for (const preset of ["essential", "standard", "strict"] as const) {
      expect(applyPreset(makeContext().config, preset).modules.automerge).toBe(false);
    }
    // turned on by hand under strict: the ruleset asks for a review, and the workflow never gives one
    const strict = applyPreset(makeContext({ modules: { automerge: true } }).config, "strict");
    expect(strict.modules.automerge).toBe(true);
    expect(strict.github?.protect).toMatchObject({ required_approvals: 1 });
    expect(readFileSync(REUSABLE, "utf8")).not.toMatch(/gh pr review|--approve/);
  });

  it("writes a workflow that calls the reusable one on Dependabot's pull requests", () => {
    const outputs = automergeModule.outputs(on());
    // the caller only: the reusable workflow it calls stays in the repokeeper repository
    expect(new Set(outputs.map((output) => output.path))).toEqual(new Set([PATH]));
    expect(outputs.every((output) => output.module === "automerge")).toBe(true);

    const out = keys(outputs);
    expect(out.name).toBe("automerge");
    expect(out.on).toEqual({ pull_request: null });
    expect(out.permissions).toEqual({ contents: "read" });
    expect(out["jobs.automerge"]).toEqual({
      uses: `vannt-dev/repokeeper/.github/workflows/dependabot-automerge.yml@${WORKFLOW_REF}`,
      permissions: { contents: "write", "pull-requests": "write" },
      with: { "merge-method": "squash" },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
      secrets: { token: "${{ secrets.AUTOMERGE_TOKEN }}" },
    });
  });

  it("merges the way the repository allows", () => {
    const method = (merge: Record<string, boolean>) =>
      (job(on({ config: { github: { merge } } })).with as Record<string, string>)["merge-method"];
    expect(method({ squash: true, merge_commit: false })).toBe("squash");
    expect(method({ squash: false })).toBe("merge");
    expect(method({ squash: false, merge_commit: false, rebase: true })).toBe("rebase");
  });

  it("follows where the reusable workflows are taken from", () => {
    expect(job(on({ repo: { owner: "vannt-dev", name: "repokeeper" } }))).toMatchObject({
      uses: "./.github/workflows/dependabot-automerge.yml",
    });
    const local = automergeModule.outputs(on({ config: { github: { workflows: { source: "local" } } } }));
    expect(local.some((output) => output.kind === "seed" && output.path === REUSABLE)).toBe(true);
    expect(keys(local)["jobs.automerge"]).toMatchObject({ uses: `./${REUSABLE}` });
    expect(listWorkflows()).toContain("dependabot-automerge.yml");
  });

  it("writes nothing on GitLab, and says what does the work there", async () => {
    expect(automergeModule.outputs(gitlabContext({ modules: { automerge: true } }))).toEqual([]);
    const noted = capture();
    await printWarnings(await tempDir(), gitlabContext({ modules: { automerge: true } }), noted.io);
    expect(noted.out).toContain(
      "note: modules.automerge writes nothing on gitlab; Renovate's own automerge setting does that work there",
    );
  });
});

describe("the reusable auto-merge workflow", () => {
  const wf = parse(readFileSync(REUSABLE, "utf8")) as {
    jobs: { automerge: { if: string; permissions: Record<string, string>; steps: Step[] } };
  };
  const { automerge } = wf.jobs;
  const [metadata, merge] = automerge.steps as [Step, Step];

  it("acts on Dependabot's pull requests only", () => {
    expect(automerge.if).toBe("github.event.pull_request.user.login == 'dependabot[bot]'");
    expect(automerge.permissions).toEqual({ contents: "write", "pull-requests": "write" });
  });

  it("turns auto-merge on for patch and minor updates, never for a major", () => {
    expect(metadata.uses).toMatch(/^dependabot\/fetch-metadata@[0-9a-f]{40}$/);
    expect(merge.if).toContain("steps.metadata.outputs.update-type == 'version-update:semver-patch'");
    expect(merge.if).toContain("steps.metadata.outputs.update-type == 'version-update:semver-minor'");
    expect(merge.if).not.toContain("semver-major");
    // auto-merge, not a merge: GitHub waits for the required checks and reviews
    expect(merge.run).toContain('gh pr merge --auto "--$METHOD" "$PR_URL"');
  });

  it("leaves auto-merge off where nothing is required, since it would then merge at once", () => {
    expect(merge.run).toContain('rules/branches/$BASE"');
    expect(merge.run).toContain('.type == "required_status_checks"');
    expect(merge.run).toContain("required_approving_review_count // 0) > 0");
    expect(merge.run).toMatch(/requires no check and no review[^\n]*\n\s*exit 0/);
  });
});

describe("the auto-merge setting", () => {
  it("is turned on by github apply when the module is on, unless written", () => {
    expect(githubSettings(makeContext().config).merge).toBeUndefined();
    expect(githubSettings(on().config).merge).toEqual({ auto_merge: true });
    const written = on({ config: { github: { merge: { squash: true, auto_merge: true } } } }).config;
    expect(githubSettings(written).merge).toEqual({ squash: true, auto_merge: true });
  });

  it("is applied as allow_auto_merge", async () => {
    const writes: { method: string; body?: unknown }[] = [];
    const api: GitHubApi = {
      async request(method, _path, body): Promise<ApiResponse> {
        if (method !== "GET") writes.push({ method, body });
        return { status: 200, data: { allow_auto_merge: false } };
      },
    };
    const changes = await planGithub(api, "o", "r", { merge: { auto_merge: true } });
    expect(changes.map((change) => [change.setting, change.from, change.to])).toEqual([
      ["merge.auto_merge", "false", "true"],
    ]);
    for (const change of changes) await change.apply(api);
    expect(writes).toEqual([{ method: "PATCH", body: { allow_auto_merge: true } }]);
  });

  it("refuses the module with auto-merge written off", () => {
    expect(() =>
      parseConfig(`${CONFIG}modules:\n  automerge: true\n  health: false\ngithub:\n  merge:\n    auto_merge: false\n`),
    ).toThrow(
      /\.repokeeper\.yml:10: github\.merge\.auto_merge is false, but modules\.automerge needs auto-merge allowed/,
    );
  });

  it("is named in the next steps once, when the workflow is new", async () => {
    const workflow: Output = { kind: "yaml", module: "automerge", path: PATH, keyPath: ["name"], value: "automerge" };
    const result = (action: string): SyncResult =>
      ({ decisions: [{ output: workflow, action }], removals: [] }) as unknown as SyncResult;
    const created = await nextSteps(".", on(), result("create"));
    expect(created).toHaveLength(1);
    expect(created[0]).toContain("run `repokeeper github apply` to allow auto-merge");
    expect(await nextSteps(".", on(), result("unchanged"))).toEqual([]);
  });
});
