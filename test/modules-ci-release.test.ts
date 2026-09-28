import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Output } from "../src/model.js";
import { ciModule } from "../src/modules/ci.js";
import { pickRelease, releaseModule } from "../src/modules/release.js";
import { PACKAGE_VERSION, WORKFLOW_REF } from "../src/version.js";
import { makeContext, nodeResolved, syncOnce, tempDir } from "./helpers.js";

const keys = (outputs: Output[]) =>
  Object.fromEntries(outputs.flatMap((o) => (o.kind === "yaml" ? [[o.keyPath.join("."), o.value]] : [])));

describe("ci module", () => {
  it("calls the reusable workflows at the moving major tag", () => {
    const out = keys(ciModule.outputs(makeContext()));
    expect(out.name).toBe("ci");
    expect(out.on).toEqual({ pull_request: null, push: { branches: ["main"] } });
    expect(out.permissions).toEqual({ contents: "read" });
    expect(out["jobs.node"]).toEqual({
      uses: `vannt-dev/repokeeper/.github/workflows/stack-node.yml@${WORKFLOW_REF}`,
      with: nodeResolved().ci?.with,
    });
    expect(out["jobs.commits"]).toEqual({
      uses: `vannt-dev/repokeeper/.github/workflows/commitlint.yml@${WORKFLOW_REF}`,
    });
  });

  it("uses local references inside the repokeeper repository", () => {
    const out = keys(ciModule.outputs(makeContext({ repo: { owner: "vannt-dev", name: "repokeeper" } })));
    expect(out["jobs.node"]).toMatchObject({ uses: "./.github/workflows/stack-node.yml" });
    expect(out["jobs.commits"]).toEqual({ uses: "./.github/workflows/commitlint.yml" });
  });

  it("follows the configured default branch and drops the commits job with the commits module", () => {
    const ctx = makeContext({ config: { github: { default_branch: "trunk" } }, modules: { commits: false } });
    const out = keys(ciModule.outputs(ctx));
    expect(out.on).toEqual({ pull_request: null, push: { branches: ["trunk"] } });
    expect(out["jobs.commits"]).toBeUndefined();
  });

  it("cancels superseded pull request runs, but never a run on the default branch", () => {
    expect(keys(ciModule.outputs(makeContext())).concurrency).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
      group: "${{ github.workflow }}-${{ github.ref }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
  });

  it("adds a drift check pinned to this repokeeper version when the drift module is on", () => {
    expect(keys(ciModule.outputs(makeContext()))["jobs.repokeeper"]).toBeUndefined();
    const out = keys(ciModule.outputs(makeContext({ modules: { drift: true } })));
    expect(out["jobs.repokeeper"]).toEqual({
      uses: `vannt-dev/repokeeper/.github/workflows/repokeeper-check.yml@${WORKFLOW_REF}`,
      with: { version: PACKAGE_VERSION },
    });
  });

  it("produces nothing when no job would run", () => {
    const ctx = makeContext({ modules: { commits: false }, stacks: [nodeResolved({ ci: null })] });
    expect(ciModule.outputs(ctx)).toEqual([]);
  });

  it("writes a workflow with its keys in the usual order", async () => {
    const root = await tempDir();
    await syncOnce(root, ciModule.outputs(makeContext()));
    const text = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(Object.keys(parse(text))).toEqual(["name", "on", "permissions", "concurrency", "jobs"]);
  });
});

describe("release module", () => {
  it("configures release-please for the stack's release type and seeds the manifest", () => {
    const outputs = releaseModule.outputs(
      makeContext({ stacks: [nodeResolved({ release: { type: "node", version: "0.3.0" } })] }),
    );
    const config = outputs.find((o) => o.path === "release-please-config.json");
    expect(config?.kind).toBe("file");
    expect(JSON.parse(config?.kind === "file" ? config.content : "")).toEqual({
      $schema: "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
      packages: {
        ".": {
          "release-type": "node",
          "changelog-path": "CHANGELOG.md",
          "bump-minor-pre-major": true,
          "include-component-in-tag": false,
        },
      },
    });
    const manifest = outputs.find((o) => o.path === ".release-please-manifest.json");
    expect(manifest).toMatchObject({ kind: "seed", content: '{\n  ".": "0.3.0"\n}\n' });
  });

  it("adds a release workflow that calls the reusable one with write permissions", () => {
    const out = keys(releaseModule.outputs(makeContext()));
    expect(out.name).toBe("release");
    expect(out.on).toEqual({ push: { branches: ["main"] } });
    expect(out.permissions).toEqual({ contents: "read" });
    expect(out["jobs.release"]).toEqual({
      uses: `vannt-dev/repokeeper/.github/workflows/release-please.yml@${WORKFLOW_REF}`,
      permissions: { contents: "write", "pull-requests": "write", issues: "write" },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
      secrets: { token: "${{ secrets.RELEASE_PLEASE_TOKEN }}" },
    });
  });

  it("starts a repository with no release yet at 0.1.0 instead of release-please's 1.0.0", () => {
    const pkg = (version: string | null, releasedVersion: string | null = null) => {
      const outputs = releaseModule.outputs(
        makeContext({
          stacks: [nodeResolved({ release: { type: "simple", version } })],
          repo: { owner: "vannt-dev", name: "example", releasedVersion },
        }),
      );
      const config = outputs.find((o) => o.path === "release-please-config.json");
      return JSON.parse(config?.kind === "file" ? config.content : "").packages["."];
    };
    expect(pkg(null)["initial-version"]).toBe("0.1.0");
    expect(pkg("0.0.0")["initial-version"]).toBe("0.1.0");
    expect(pkg("0.3.0")).not.toHaveProperty("initial-version");
    // a version file release-please never bumps (gradle.properties without markers) still reads 0.0.0 after v1.0.0
    expect(pkg("0.0.0", "1.0.0")).not.toHaveProperty("initial-version");
  });

  it("approves the held pull_request runs of release pull requests opened with GITHUB_TOKEN", () => {
    const job = keys(releaseModule.outputs(makeContext()))["jobs.release-pr-ci"] as {
      steps: { env: Record<string, string>; run: string }[];
    };
    expect(job).toMatchObject({
      needs: "release",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
      if: "${{ needs.release.outputs.pr_branch != '' }}",
      "runs-on": "ubuntu-latest",
      permissions: { actions: "write" },
    });
    expect(job.steps[0]?.env).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
      GH_TOKEN: "${{ github.token }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
      BRANCH: "${{ needs.release.outputs.pr_branch }}",
    });
    const run = job.steps[0]?.run ?? "";
    expect(run).toContain("actions/runs?branch=$BRANCH&event=pull_request&status=action_required");
    expect(run).toContain('gh api -X POST "repos/$GITHUB_REPOSITORY/actions/runs/$id/approve"');
  });

  it("prefers a language release type and falls back to simple at 0.0.0", () => {
    const simple = nodeResolved({ id: "node", release: { type: "simple", version: null } });
    expect(pickRelease([simple, nodeResolved({ release: { type: "node", version: "2.0.0" } })])).toEqual({
      type: "node",
      version: "2.0.0",
    });
    expect(pickRelease([])).toEqual({ type: "simple", version: null });
    const manifest = releaseModule.outputs(makeContext({ stacks: [] })).find((o) => o.kind === "seed");
    expect(manifest).toMatchObject({ content: '{\n  ".": "0.0.0"\n}\n' });
  });
});
