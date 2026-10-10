import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { BlockOutput, FileOutput, JsonOutput } from "../src/model.js";
import { commitsModule } from "../src/modules/commits.js";
import { editorconfigModule } from "../src/modules/editorconfig.js";
import { gitignoreModule } from "../src/modules/gitignore.js";
import { hooksModule } from "../src/modules/hooks.js";
import { TOOL_VERSIONS } from "../src/version.js";
import { makeContext, nodeResolved, tempDir } from "./helpers.js";

const execFileAsync = promisify(execFile);

describe("editorconfig", () => {
  it("writes .editorconfig and a .gitattributes block that keeps CRLF for Windows scripts", () => {
    const [config, attributes] = editorconfigModule.outputs(makeContext()) as [FileOutput, BlockOutput];
    expect(config.path).toBe(".editorconfig");
    expect(config.content).toContain("root = true");
    expect(config.content).toContain("end_of_line = lf");
    expect(attributes).toMatchObject({ kind: "block", path: ".gitattributes", id: "editorconfig", comment: "hash" });
    expect(attributes.body).toContain("* text=auto eol=lf");
    expect(attributes.body).toContain("*.ps1 text eol=crlf");
  });

  it("uses only patterns git understands, since gitattributes has no brace expansion", async () => {
    const [, attributes] = editorconfigModule.outputs(makeContext()) as [FileOutput, BlockOutput];
    expect(attributes.body).not.toMatch(/[{}]/);
    const root = await tempDir();
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, ".gitattributes"), `${attributes.body}\n`);
    const { stdout } = await execFileAsync("git", ["check-attr", "eol", "binary", "--", "a.ps1", "a.png", "a.md"], {
      cwd: root,
    });
    expect(stdout).toContain("a.ps1: eol: crlf");
    expect(stdout).toContain("a.png: binary: set");
    expect(stdout).toContain("a.md: eol: lf");
  });
});

describe("gitignore", () => {
  it("adds the stack templates and ignores repokeeper's conflict files", () => {
    const [block] = gitignoreModule.outputs(makeContext()) as [BlockOutput];
    expect(block).toMatchObject({ kind: "block", path: ".gitignore", id: "gitignore" });
    expect(block.body).toContain("## Node (github/gitignore)");
    expect(block.body).toContain("node_modules/");
    expect(block.body.endsWith("*.repokeeper-new")).toBe(true);
  });
});

describe("commits", () => {
  it("configures commitlint and adds its packages for node", () => {
    const outputs = commitsModule.outputs(makeContext());
    const config = outputs.find((o) => o.kind === "file") as FileOutput;
    expect(config.path).toBe("commitlint.config.mjs");
    expect(config.content).toContain('extends: ["@commitlint/config-conventional"]');
    expect(config.content).toContain('"header-max-length": [2, "always", 100]');
    const json = outputs.filter((o): o is JsonOutput => o.kind === "json");
    expect(json.map((o) => [o.keyPath.join("."), o.value])).toEqual([
      ["devDependencies.@commitlint/cli", "^21.2.3"],
      ["devDependencies.@commitlint/config-conventional", "^21.2.3"],
    ]);
  });
});

describe("hooks", () => {
  it("runs staged-file jobs, commitlint and tests", () => {
    const outputs = hooksModule.outputs(makeContext());
    const file = outputs.find((o) => o.kind === "file") as FileOutput;
    expect(file.path).toBe("lefthook.yml");
    const config = parse(file.content);
    expect(config["pre-commit"]).toEqual({
      parallel: true,
      jobs: [
        {
          name: "node:prettier",
          glob: "*.{js,ts}",
          run: "npx prettier --write --ignore-unknown {staged_files}",
          stage_fixed: true,
        },
      ],
    });
    expect(config["commit-msg"]).toEqual({
      jobs: [{ name: "commitlint", run: "npx --no-install commitlint --edit {1}" }],
    });
    expect(config["pre-push"]).toEqual({ jobs: [{ name: "node:test", run: "npm test" }] });
    const json = outputs.find((o) => o.kind === "json") as JsonOutput;
    expect([json.keyPath.join("."), json.value]).toEqual(["devDependencies.lefthook", `^${TOOL_VERSIONS.lefthook}`]);
  });

  it("drops hooks that have nothing to run", () => {
    const ctx = makeContext({ modules: { commits: false }, stacks: [nodeResolved({ staged: [], test: null })] });
    const file = hooksModule.outputs(ctx).find((o) => o.kind === "file") as FileOutput;
    expect(parse(file.content)).toEqual({});
  });
});
