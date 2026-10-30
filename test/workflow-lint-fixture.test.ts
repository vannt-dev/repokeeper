import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { run } from "../src/cli.js";
import { capture, tempDir } from "./helpers.js";

/**
 * fixtures/workflow-lint holds the .github folder repokeeper writes with every module on, for every stack
 * it has a fixture of. workflow-tests.yml runs the workflow lint on it, so a change that makes repokeeper
 * write something actionlint or zizmor objects to fails there. This test keeps the folder current:
 * REPOKEEPER_UPDATE_FIXTURE=1 npx vitest run test/workflow-lint-fixture.test.ts writes it again.
 */
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const TARGET = join(FIXTURES, "workflow-lint");
const STACKS = [
  "node:node",
  "python:python",
  "dart:dart",
  "script:script",
  "java:java-gradle",
  "dotnet:dotnet",
  "go:go",
  "rust:rust",
  "kotlin:kotlin",
  "php:php",
  "ruby:ruby",
  "docker:docker",
];
const OPT_IN = ["drift", "autoupdate", "security", "cache_cleanup", "automerge", "publish", "workflow_lint"];

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

async function files(root: string, dir = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(root, path)));
    else found.push(relative(root, path).replaceAll("\\", "/"));
  }
  return found.sort();
}

/** The .github folder of a repository holding every stack fixture, with every module switched on. */
async function generate(): Promise<Map<string, string>> {
  const dir = await tempDir();
  for (const stack of STACKS) {
    const folder = stack.split(":")[1] as string;
    await cp(join(FIXTURES, folder), join(dir, folder), { recursive: true });
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "remote", "add", "origin", "https://github.com/demo-owner/demo.git");
  const quiet = () => capture(dir).io;
  expect(await run(["init", "--preset", "strict", ...STACKS.flatMap((s) => ["--stack", s])], quiet())).toBe(0);
  const doc = parseDocument(await readFile(join(dir, ".repokeeper.yml"), "utf8"));
  for (const id of OPT_IN) doc.setIn(["modules", id], true);
  await writeFile(join(dir, ".repokeeper.yml"), doc.toString());
  expect(await run(["update"], quiet())).toBe(0);

  const out = new Map<string, string>();
  for (const path of await files(join(dir, ".github"))) {
    out.set(path, (await readFile(join(dir, ".github", path), "utf8")).replaceAll("\r\n", "\n"));
  }
  return out;
}

describe("the workflow lint fixture", () => {
  it("is what repokeeper writes with every module on", { timeout: 120_000 }, async () => {
    const generated = await generate();
    // what the fixture is there for
    expect([...generated.keys()]).toEqual(
      expect.arrayContaining([
        "dependabot.yml",
        "zizmor.yml",
        "workflows/ci.yml",
        "workflows/release.yml",
        "workflows/cache-cleanup.yml",
        "workflows/workflow-lint.yml",
      ]),
    );
    if (process.env.REPOKEEPER_UPDATE_FIXTURE === "1") {
      await rm(TARGET, { recursive: true, force: true });
      for (const [path, content] of generated) {
        await mkdir(join(TARGET, ".github", path, ".."), { recursive: true });
        await writeFile(join(TARGET, ".github", path), content);
      }
    }
    const committed = new Map<string, string>();
    for (const path of await files(join(TARGET, ".github"))) {
      committed.set(path, (await readFile(join(TARGET, ".github", path), "utf8")).replaceAll("\r\n", "\n"));
    }
    expect(
      committed,
      "fixtures/workflow-lint is out of date: REPOKEEPER_UPDATE_FIXTURE=1 npx vitest run test/workflow-lint-fixture.test.ts",
    ).toEqual(generated);
  });
});
