import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { run } from "../src/cli.js";
import { setLocalWorkflows } from "../src/commands/eject.js";
import { parseConfig } from "../src/config/load.js";
import type { WorkflowSource } from "../src/github/settings.js";
import type { Output } from "../src/model.js";
import { planOutputs } from "../src/plan.js";
import { listWorkflows, REUSABLE_WORKFLOW } from "../src/templates.js";
import { PACKAGE_VERSION, WORKFLOW_REF } from "../src/version.js";
import { capture, makeContext, tempDir } from "./helpers.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

function plan(workflows?: WorkflowSource, repo = { owner: "acme", name: "shop" }): Output[] {
  return planOutputs(makeContext({ config: workflows ? { github: { workflows } } : {}, repo }));
}

function uses(outputs: Output[], file: string, job: string): string {
  const output = outputs.find(
    (o) => o.kind === "yaml" && o.path === `.github/workflows/${file}` && o.keyPath.join(".") === `jobs.${job}`,
  );
  if (output?.kind !== "yaml") throw new Error(`no job ${job} in ${file}`);
  return (output.value as { uses: string }).uses;
}

function githubActionsUpdate(outputs: Output[]): Record<string, unknown> {
  const file = outputs.find((o) => o.path === ".github/dependabot.yml");
  if (file?.kind !== "file") throw new Error("no dependabot.yml");
  return parse(file.content).updates.find((u: Record<string, string>) => u["package-ecosystem"] === "github-actions");
}

const seeds = (outputs: Output[]) => outputs.filter((o) => o.kind === "seed" && /workflows\//.test(o.path));

describe("where the reusable workflows are called from", () => {
  it("follows repokeeper's moving major tag unless told otherwise", () => {
    const outputs = plan();
    expect(uses(outputs, "ci.yml", "node")).toBe(
      `vannt-dev/repokeeper/.github/workflows/stack-node.yml@${WORKFLOW_REF}`,
    );
    expect(uses(outputs, "release.yml", "release")).toBe(
      `vannt-dev/repokeeper/.github/workflows/release-please.yml@${WORKFLOW_REF}`,
    );
    expect(githubActionsUpdate(outputs)).not.toHaveProperty("ignore");
    expect(seeds(outputs)).toEqual([]);
  });

  it("pins to the release of the repokeeper that wrote the file with ref: exact", () => {
    const outputs = plan({ ref: "exact" });
    expect(uses(outputs, "ci.yml", "node")).toBe(
      `vannt-dev/repokeeper/.github/workflows/stack-node.yml@v${PACKAGE_VERSION}`,
    );
    expect(uses(outputs, "ci.yml", "commits")).toBe(
      `vannt-dev/repokeeper/.github/workflows/commitlint.yml@v${PACKAGE_VERSION}`,
    );
    // `repokeeper update` moves the pin; a Dependabot bump of it would be drift every time
    expect(githubActionsUpdate(outputs).ignore).toEqual([{ "dependency-name": "vannt-dev/repokeeper*" }]);
  });

  it("uses a tag or a commit SHA as written", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(uses(plan({ ref: sha }), "ci.yml", "node")).toBe(
      `vannt-dev/repokeeper/.github/workflows/stack-node.yml@${sha}`,
    );
    expect(uses(plan({ ref: "v0.5.0" }), "release.yml", "release")).toBe(
      "vannt-dev/repokeeper/.github/workflows/release-please.yml@v0.5.0",
    );
    expect(githubActionsUpdate(plan({ ref: sha })).ignore).toEqual([{ "dependency-name": "vannt-dev/repokeeper*" }]);
  });

  it("calls a copy in a repository of the organisation, at main unless a ref is named", () => {
    const mirrored = plan({ source: "acme/ci-workflows" });
    expect(uses(mirrored, "ci.yml", "node")).toBe("acme/ci-workflows/.github/workflows/stack-node.yml@main");
    // an unpinned branch is the organisation's to move; Dependabot is not told to keep away
    expect(githubActionsUpdate(mirrored)).not.toHaveProperty("ignore");

    const pinned = plan({ source: "acme/ci-workflows", ref: "v3" });
    expect(uses(pinned, "ci.yml", "node")).toBe("acme/ci-workflows/.github/workflows/stack-node.yml@v3");
    expect(githubActionsUpdate(pinned).ignore).toEqual([{ "dependency-name": "acme/ci-workflows*" }]);

    expect(() => plan({ source: "acme/ci-workflows", ref: "exact" })).toThrow(
      "github.workflows.ref: exact follows repokeeper's own releases; for acme/ci-workflows, name a tag, a branch or a commit",
    );
  });

  it("keeps its own copies with source: local, written once and then the repository's", () => {
    const ctx = makeContext({
      config: { github: { workflows: { source: "local" } } },
      modules: { drift: true },
      repo: { owner: "acme", name: "shop" },
    });
    const outputs = planOutputs(ctx);
    expect(uses(outputs, "ci.yml", "node")).toBe("./.github/workflows/stack-node.yml");
    expect(uses(outputs, "ci.yml", "repokeeper")).toBe("./.github/workflows/repokeeper-check.yml");
    expect(uses(outputs, "release.yml", "release")).toBe("./.github/workflows/release-please.yml");

    // only the workflows this repository calls, not all eleven stacks
    expect(seeds(outputs).map((o) => o.path)).toEqual([
      ".github/workflows/commitlint.yml",
      ".github/workflows/release-please.yml",
      ".github/workflows/repokeeper-check.yml",
      ".github/workflows/stack-node.yml",
    ]);
    const stack = seeds(outputs).find((o) => o.path.endsWith("stack-node.yml"));
    if (stack?.kind !== "seed") throw new Error("no seed");
    expect(stack.content.split("\n")[0]).toBe(
      `# Copied from repokeeper ${PACKAGE_VERSION} (https://github.com/vannt-dev/repokeeper). This copy is yours: repokeeper does not update it.`,
    );
    expect(parse(stack.content).on).toHaveProperty("workflow_call");
    expect(githubActionsUpdate(outputs)).not.toHaveProperty("ignore");
  });

  it("leaves repokeeper's own repository calling its own files, with no copies", () => {
    const outputs = plan({ ref: "exact" }, { owner: "vannt-dev", name: "repokeeper" });
    expect(uses(outputs, "ci.yml", "node")).toBe("./.github/workflows/stack-node.yml");
    expect(seeds(outputs)).toEqual([]);
    expect(githubActionsUpdate(outputs)).not.toHaveProperty("ignore");
  });
});

describe("workflows in .repokeeper.yml", () => {
  const base = "schema: 1\nstandard: 1.0.0\nplatform: github\nstacks: [node]\nmodules: { health: false }\n";

  it("accepts a source and a ref, and says what is wrong with a bad one", () => {
    expect(
      parseConfig(`${base}github:\n  workflows: { source: acme/ci-workflows, ref: v3 }\n`).github?.workflows,
    ).toEqual({
      source: "acme/ci-workflows",
      ref: "v3",
    });
    expect(parseConfig(`${base}github:\n  workflows: { source: local }\n`).github?.workflows).toEqual({
      source: "local",
    });
    expect(() => parseConfig(`${base}github:\n  workflows: { source: not a repository }\n`)).toThrow(
      /\.repokeeper\.yml:7: github\.workflows\.source/,
    );
    expect(() => parseConfig(`${base}github:\n  workflows: { ref: "v1 || rm" }\n`)).toThrow(/github\.workflows\.ref/);
    expect(() => parseConfig(`${base}github:\n  workflows: { pin: true }\n`)).toThrow(
      "github.workflows.pin is not a known key",
    );
  });

  it("sets source: local in place, keeping comments, and drops a ref that no longer applies", () => {
    const text = `# my config\n${base}github:\n  # how we merge\n  merge: { squash: true }\n  workflows:\n    ref: exact\n`;
    const edited = setLocalWorkflows(text);
    expect(edited).toContain("# my config");
    expect(edited).toContain("# how we merge");
    expect(parseConfig(edited).github).toEqual({ merge: { squash: true }, workflows: { source: "local" } });
    expect(parseConfig(setLocalWorkflows(base)).github).toEqual({ workflows: { source: "local" } });
  });
});

describe("eject", () => {
  async function repokeeper(dir: string, ...args: string[]) {
    const c = capture(dir);
    const code = await run(args, c.io);
    return { code, out: c.out.join("\n"), err: c.err.join("\n") };
  }

  async function standardRepo(): Promise<string> {
    const dir = await tempDir();
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, devDependencies: { prettier: "^3.0.0" } }, null, 2)}\n`,
    );
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.name", "Demo User");
    sh(dir, "config", "user.email", "demo@example.com");
    sh(dir, "config", "core.autocrlf", "false");
    sh(dir, "remote", "add", "origin", "https://github.com/demo-owner/demo.git");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: initial");
    expect((await repokeeper(dir, "init")).code).toBe(0);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: apply standard");
    return dir;
  }

  it("copies the workflows this repository calls, points the callers at them, and stays in sync", async () => {
    const dir = await standardRepo();
    const before = await readFile(join(dir, ".repokeeper.yml"), "utf8");

    const preview = await repokeeper(dir, "eject", "--dry-run");
    expect(preview.code).toBe(0);
    expect(preview.out).toContain(".github/workflows/stack-node.yml");
    expect(preview.out).toContain("dry run: nothing written");
    expect(await readFile(join(dir, ".repokeeper.yml"), "utf8")).toBe(before);
    expect(existsSync(join(dir, ".github/workflows/stack-node.yml"))).toBe(false);

    const eject = await repokeeper(dir, "eject");
    expect(eject.err).toBe("");
    expect(eject.code).toBe(0);
    expect(eject.out).toContain("the reusable workflows are now files of this repository");

    expect(parse(await readFile(join(dir, ".repokeeper.yml"), "utf8")).github.workflows).toEqual({ source: "local" });
    const ci = parse(await readFile(join(dir, ".github/workflows/ci.yml"), "utf8"));
    expect(ci.jobs.node.uses).toBe("./.github/workflows/stack-node.yml");
    expect(ci.jobs.commits.uses).toBe("./.github/workflows/commitlint.yml");
    const release = parse(await readFile(join(dir, ".github/workflows/release.yml"), "utf8"));
    expect(release.jobs.release.uses).toBe("./.github/workflows/release-please.yml");
    expect((await readdir(join(dir, ".github/workflows"))).sort()).toEqual([
      "ci.yml",
      "commitlint.yml",
      "release-please.yml",
      "release.yml",
      "stack-node.yml",
    ]);

    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "ci: keep our own copies of the reusable workflows");
    expect((await repokeeper(dir, "check")).code).toBe(0);

    // the copies are the repository's: changing one is not drift, and update leaves it alone
    await appendFile(join(dir, ".github/workflows/stack-node.yml"), "# pinned our own runner image\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "ci: tune the node workflow");
    expect((await repokeeper(dir, "check")).code).toBe(0);
    expect((await repokeeper(dir, "update")).code).toBe(0);
    expect(await readFile(join(dir, ".github/workflows/stack-node.yml"), "utf8")).toContain(
      "# pinned our own runner image",
    );
  });

  it("writes every reusable workflow into another repository's folder with --to", async () => {
    const dir = await standardRepo();
    const central = await tempDir();

    const eject = await repokeeper(dir, "eject", "--to", central);
    expect(eject.code).toBe(0);
    const written = (await readdir(join(central, ".github/workflows"))).sort();
    expect(written).toEqual(listWorkflows());
    expect(written).toContain("stack-go.yml");
    expect(written.every((file) => REUSABLE_WORKFLOW.test(file))).toBe(true);
    expect(eject.out).toContain("source: your-org/that-repository");
    // this repository is not touched
    expect(parse(await readFile(join(dir, ".repokeeper.yml"), "utf8")).github).toBeUndefined();

    const again = await repokeeper(dir, "eject", "--to", central);
    expect(again.code).toBe(2);
    expect(again.err).toContain("already exist");
    expect((await repokeeper(dir, "eject", "--to", central, "--force")).code).toBe(0);
  });

  it("is for GitHub, and --to belongs to it alone", async () => {
    const dir = await standardRepo();
    const misplaced = await repokeeper(dir, "check", "--to", "elsewhere");
    expect(misplaced.code).toBe(2);
    expect(misplaced.err).toContain("--to is only for eject");
  });
});
