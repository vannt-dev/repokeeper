import { describe, expect, it } from "vitest";
import { parseConfig, renderConfig } from "../src/config/load.js";
import type { Output } from "../src/model.js";
import { autoupdateModule } from "../src/modules/autoupdate.js";
import { MODULES } from "../src/modules/index.js";
import { planOutputs } from "../src/plan.js";
import { WORKFLOW_REF } from "../src/version.js";
import { gitlabContext, makeContext } from "./helpers.js";

const PATH = ".github/workflows/repokeeper-autoupdate.yml";
const REUSABLE = ".github/workflows/repokeeper-update.yml";
const keys = (outputs: Output[]) =>
  Object.fromEntries(outputs.flatMap((o) => (o.kind === "yaml" ? [[o.keyPath.join("."), o.value]] : [])));

describe("autoupdate module", () => {
  it("is off unless asked for, and round-trips through the configuration file", () => {
    expect(makeContext().config.modules.autoupdate).toBe(false);
    expect(autoupdateModule.enabled(makeContext().config)).toBe(false);
    expect(planOutputs(makeContext()).some((output) => output.path === PATH)).toBe(false);

    const on = makeContext({ modules: { autoupdate: true } }).config;
    expect(autoupdateModule.enabled(on)).toBe(true);
    expect(parseConfig(renderConfig(on)).modules.autoupdate).toBe(true);
    expect(MODULES).toContain(autoupdateModule);
  });

  it("writes a scheduled workflow that calls the reusable update workflow with the newest repokeeper", () => {
    const outputs = autoupdateModule.outputs(makeContext({ modules: { autoupdate: true } }));
    // the caller only: the reusable workflow it calls stays in the repokeeper repository
    expect(new Set(outputs.map((output) => output.path))).toEqual(new Set([PATH]));
    expect(outputs.every((output) => output.module === "autoupdate")).toBe(true);

    const out = keys(outputs);
    expect(out.name).toBe("repokeeper update");
    // weekly, and by hand; never on a push, so it cannot loop on its own pull request
    expect(out.on).toEqual({ schedule: [{ cron: "23 5 * * 1" }], workflow_dispatch: null });
    expect(out.permissions).toEqual({ contents: "read" });
    expect(out["jobs.update"]).toEqual({
      uses: `vannt-dev/repokeeper/.github/workflows/repokeeper-update.yml@${WORKFLOW_REF}`,
      permissions: { contents: "write", "pull-requests": "write" },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
      secrets: { token: "${{ secrets.REPOKEEPER_TOKEN }}" },
    });
    // a pull request opened with GITHUB_TOKEN has its runs held; they are approved as for a release
    expect(out["jobs.update-pr-ci"]).toMatchObject({
      needs: "update",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
      if: "${{ needs.update.outputs.pr_branch != '' }}",
      permissions: { actions: "write" },
    });
  });

  it("follows where the reusable workflows are taken from", () => {
    const self = keys(
      autoupdateModule.outputs(
        makeContext({ modules: { autoupdate: true }, repo: { owner: "vannt-dev", name: "repokeeper" } }),
      ),
    );
    expect(self["jobs.update"]).toMatchObject({ uses: "./.github/workflows/repokeeper-update.yml" });

    const local = autoupdateModule.outputs(
      makeContext({ modules: { autoupdate: true }, config: { github: { workflows: { source: "local" } } } }),
    );
    // a repository that keeps its own copies gets one of this workflow too
    expect(local.some((output) => output.kind === "seed" && output.path === REUSABLE)).toBe(true);
    expect(keys(local)["jobs.update"]).toMatchObject({ uses: `./${REUSABLE}` });
  });

  it("writes nothing on GitLab", () => {
    expect(autoupdateModule.outputs(gitlabContext({ modules: { autoupdate: true } }))).toEqual([]);
  });
});
