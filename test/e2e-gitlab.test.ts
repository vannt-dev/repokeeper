import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { run } from "../src/cli.js";
import { capture, tempDir } from "./helpers.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

async function nodeRepo(remote: string | null, branch = "main"): Promise<string> {
  const dir = await tempDir();
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "demo", version: "0.1.0", scripts: { test: "vitest run" } }, null, 2)}\n`,
  );
  sh(dir, "init", "-q", "-b", branch);
  sh(dir, "config", "user.name", "Demo User");
  sh(dir, "config", "user.email", "demo@example.com");
  sh(dir, "config", "core.autocrlf", "false");
  if (remote) sh(dir, "remote", "add", "origin", remote);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "chore: initial");
  return dir;
}

async function repokeeper(dir: string, ...args: string[]) {
  const c = capture(dir);
  const code = await run(args, c.io);
  return { code, out: c.out.join("\n"), err: c.err.join("\n") };
}

const read = (dir: string, path: string) => readFile(join(dir, path), "utf8");

describe("repokeeper on gitlab, end to end", () => {
  it("detects gitlab from the remote, writes the gitlab standard and checks clean", async () => {
    const dir = await nodeRepo("https://gitlab.com/acme/tools/demo.git");
    const init = await repokeeper(dir, "init");
    expect(init.err).toBe("");
    expect(init.code).toBe(0);

    const config = parse(await read(dir, ".repokeeper.yml"));
    expect(config.platform).toBe("gitlab");
    expect(config.modules.health.contact).toBe("https://gitlab.com/acme/tools");
    expect(config.modules.health.codeowners).toEqual(["@acme/tools"]);
    expect(config.github).toBeUndefined();

    for (const path of [
      ".gitlab-ci.yml",
      ".releaserc.json",
      "renovate.json",
      ".gitlab/CODEOWNERS",
      ".gitlab/issue_templates/Bug.md",
      ".gitlab/merge_request_templates/Default.md",
    ]) {
      expect(existsSync(join(dir, path)), path).toBe(true);
    }
    for (const path of [".github", "release-please-config.json", ".release-please-manifest.json"]) {
      expect(existsSync(join(dir, path)), path).toBe(false);
    }
    const ci = parse(await read(dir, ".gitlab-ci.yml"));
    expect(Object.keys(ci)).toEqual(["workflow", "node", "commits", "renovate", "release"]);
    expect(ci.node.script).toEqual(["npm install", "npm run test"]);
    expect(await read(dir, "SECURITY.md")).toContain("https://gitlab.com/acme/tools/demo/-/issues/new");

    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: sync");
    expect((await repokeeper(dir, "check")).code).toBe(0);
  });

  it("takes --platform over the remote and stores a default branch other than main under gitlab", async () => {
    const dir = await nodeRepo(null, "trunk");
    sh(dir, "remote", "add", "origin", dir);
    sh(dir, "fetch", "-q", "origin");
    sh(dir, "remote", "set-head", "origin", "trunk");

    expect((await repokeeper(dir, "init", "--platform", "gitlab")).code).toBe(0);
    const config = parse(await read(dir, ".repokeeper.yml"));
    expect(config.platform).toBe("gitlab");
    expect(config.gitlab).toEqual({ default_branch: "trunk" });
    expect(config.modules.health.contact).toBe("the repository maintainers");
    expect(JSON.parse(await read(dir, ".releaserc.json")).branches).toEqual(["trunk"]);
  });

  it("stays on github for a GitHub remote and for no remote", async () => {
    for (const remote of ["https://github.com/demo-owner/demo.git", null]) {
      const dir = await nodeRepo(remote);
      expect((await repokeeper(dir, "init")).code).toBe(0);
      expect(parse(await read(dir, ".repokeeper.yml")).platform).toBe("github");
      expect(existsSync(join(dir, ".gitlab-ci.yml"))).toBe(false);
    }
  });

  it("refuses an unsupported stack before writing anything", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
    sh(dir, "init", "-q", "-b", "main");
    const init = await repokeeper(dir, "init", "--platform", "gitlab");
    expect(init.code).toBe(2);
    expect(init.err).toContain('stack "python" is not supported on gitlab yet (supported: node)');
    expect(existsSync(join(dir, ".repokeeper.yml"))).toBe(false);
  });

  it("rejects --platform with an unknown value or outside init", async () => {
    const dir = await nodeRepo(null);
    const unknown = await repokeeper(dir, "init", "--platform", "bitbucket");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown platform bitbucket; expected github or gitlab");
    const check = await repokeeper(dir, "check", "--platform", "gitlab");
    expect(check.code).toBe(2);
    expect(check.err).toContain("--platform is only for init");
  });

  it("refuses github apply on a gitlab repository", async () => {
    const dir = await nodeRepo("https://gitlab.com/acme/demo.git");
    expect((await repokeeper(dir, "init")).code).toBe(0);
    const apply = await repokeeper(dir, "github", "apply", "--dry-run");
    expect(apply.code).toBe(2);
    expect(apply.err).toContain("this repository uses the gitlab platform");
  });
});
