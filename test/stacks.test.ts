import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STACK_IDS } from "../src/config/types.js";
import { UsageError } from "../src/errors.js";
import { detectStacks, getStackPack } from "../src/stacks/index.js";
import { nodeStack } from "../src/stacks/node.js";
import { tempDir } from "./helpers.js";

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

describe("node stack", () => {
  it("uses prettier and eslint when installed, with npm by default", async () => {
    const dir = await repoWith({
      "package.json": JSON.stringify({
        scripts: { test: "vitest run" },
        devDependencies: { prettier: "3", eslint: "9" },
      }),
    });
    const stack = await nodeStack.resolve(dir);
    expect(stack.staged.map((j) => j.name)).toEqual(["node:prettier", "node:eslint"]);
    expect(stack.test).toBe("npm test");
    expect(stack.install).toBe("npm install");
    expect(stack.gitignore).toEqual(["Node"]);
    expect(stack.dependabot).toEqual(["npm"]);
  });

  it("prefers biome and follows the pnpm lockfile", async () => {
    const dir = await repoWith({
      "package.json": JSON.stringify({
        scripts: { test: "vitest" },
        devDependencies: { "@biomejs/biome": "2", prettier: "3" },
      }),
      "pnpm-lock.yaml": "",
    });
    const stack = await nodeStack.resolve(dir);
    expect(stack.staged.map((j) => j.name)).toEqual(["node:biome"]);
    expect(stack.test).toBe("pnpm test");
  });

  it("skips npm's placeholder test script and missing tools", async () => {
    const dir = await repoWith({
      "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      "yarn.lock": "",
    });
    const stack = await nodeStack.resolve(dir);
    expect(stack.staged).toEqual([]);
    expect(stack.test).toBeNull();
    expect(stack.install).toBe("yarn install");
  });

  it("reports an unreadable package.json as a usage error", async () => {
    const dir = await repoWith({ "package.json": "{ not json" });
    await expect(nodeStack.resolve(dir)).rejects.toBeInstanceOf(UsageError);
  });
});

describe("registry", () => {
  it("detects node from package.json", async () => {
    expect(await detectStacks(await repoWith({ "package.json": "{}" }))).toEqual(["node"]);
    expect(await detectStacks(await repoWith({ "README.md": "" }))).toEqual([]);
  });

  it("detects the script stack only when no other stack is present", async () => {
    expect(await detectStacks(await repoWith({ "deploy.sh": "" }))).toEqual(["script"]);
    expect(await detectStacks(await repoWith({ "deploy.sh": "", "package.json": "{}" }))).toEqual(["node"]);
  });

  it("detects kotlin instead of java for a Gradle build with a Kotlin plugin", async () => {
    const dir = await repoWith({ "build.gradle.kts": 'plugins {\n    kotlin("jvm") version "2.4.20"\n}\n' });
    expect(await detectStacks(dir)).toEqual(["kotlin"]);
    expect(await detectStacks(await repoWith({ "build.gradle.kts": "plugins { java }\n" }))).toEqual(["java"]);
  });

  it("has a pack for every stack id", () => {
    for (const id of STACK_IDS) expect(getStackPack(id).id).toBe(id);
  });
});
