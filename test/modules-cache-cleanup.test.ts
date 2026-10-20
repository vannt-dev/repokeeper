import { describe, expect, it } from "vitest";
import { printWarnings } from "../src/commands/report.js";
import { parseConfig, renderConfig } from "../src/config/load.js";
import type { Output } from "../src/model.js";
import { cacheCleanupModule } from "../src/modules/cache-cleanup.js";
import { MODULES } from "../src/modules/index.js";
import { planOutputs } from "../src/plan.js";
import { capture, gitlabContext, makeContext, tempDir } from "./helpers.js";

const PATH = ".github/workflows/cache-cleanup.yml";
const keys = (outputs: Output[]) =>
  Object.fromEntries(outputs.flatMap((o) => (o.kind === "yaml" ? [[o.keyPath.join("."), o.value]] : [])));
const on = (overrides: Parameters<typeof makeContext>[0] = {}) =>
  makeContext({ ...overrides, modules: { cache_cleanup: true, ...overrides.modules } });

interface Step {
  name: string;
  env: Record<string, string>;
  run: string;
}

describe("cache cleanup module", () => {
  it("is off unless asked for, and round-trips through the configuration file", () => {
    expect(makeContext().config.modules.cache_cleanup).toBe(false);
    expect(cacheCleanupModule.enabled(makeContext().config)).toBe(false);
    expect(planOutputs(makeContext()).some((output) => output.path === PATH)).toBe(false);
    // a file without the line is one every earlier repokeeper reads as well
    expect(renderConfig(makeContext().config)).not.toContain("cache_cleanup");

    expect(cacheCleanupModule.enabled(on().config)).toBe(true);
    expect(parseConfig(renderConfig(on().config)).modules.cache_cleanup).toBe(true);
    expect(MODULES).toContain(cacheCleanupModule);
  });

  it("deletes a pull request's caches when it closes, and sweeps weekly", () => {
    const outputs = cacheCleanupModule.outputs(on());
    expect(new Set(outputs.map((output) => output.path))).toEqual(new Set([PATH]));
    expect(outputs.every((output) => output.module === "cache_cleanup")).toBe(true);

    const out = keys(outputs);
    expect(out.name).toBe("cache cleanup");
    expect(out.on).toEqual({
      // pull_request_target: a pull request from a fork gets a token that can delete caches too
      pull_request_target: { types: ["closed"] },
      schedule: [{ cron: "23 3 * * 0" }],
      workflow_dispatch: null,
    });
    // nothing is checked out: the job reads only the pull request number
    expect(out.permissions).toEqual({ actions: "write", contents: "read", "pull-requests": "read" });
    const job = out["jobs.cleanup"] as { "runs-on": string; "timeout-minutes": number; steps: Step[] };
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBe(10);
    expect(job.steps).toHaveLength(1);
    const [step] = job.steps as [Step];
    expect(step.env).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
      GH_TOKEN: "${{ github.token }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
      GH_REPO: "${{ github.repository }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
      PR_NUMBER: "${{ github.event.pull_request.number }}",
    });
    // no expression in the script itself: the pull request number reaches it through the environment
    expect(step.run).not.toContain("${{");
    expect(step.run).toContain("filter='map(select(.ref == \"refs/pull/'\"$PR_NUMBER\"'/merge\"))'");
    // per branch and kind of cache, a copy left unused for a day longer than the newest one goes
    expect(step.run).toContain("map(select(t < $newest - 86400))");
    expect(step.run).toContain('gh api -X DELETE "repos/$GH_REPO/actions/caches/$id"');
    // no third-party action: Dependabot has nothing to bump in a file repokeeper manages
    expect(JSON.stringify(job)).not.toContain('"uses"');
  });

  it("writes nothing on GitLab, where there are no Actions caches", () => {
    expect(cacheCleanupModule.outputs(gitlabContext({ modules: { cache_cleanup: true } }))).toEqual([]);
  });

  it("says so on GitLab, and nothing on GitHub", async () => {
    const noted = capture();
    await printWarnings(await tempDir(), gitlabContext({ modules: { cache_cleanup: true } }), noted.io);
    expect(noted.out).toContain(
      "note: modules.cache_cleanup writes nothing on gitlab; there are no Actions caches there, and runner caches expire on the runner",
    );
    const quiet = capture();
    await printWarnings(await tempDir(), on(), quiet.io);
    expect(quiet.out.join("\n")).not.toContain("cache_cleanup");
  });
});
