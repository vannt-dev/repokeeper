import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

  it("writes a go job per version and a release that is the changelog and the tag", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "go.mod"), "module example.com/demo\n\ngo 1.22\n");
    await writeFile(join(dir, "demo.go"), "package demo\n");
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.name", "Demo User");
    sh(dir, "config", "user.email", "demo@example.com");
    sh(dir, "config", "core.autocrlf", "false");
    sh(dir, "remote", "add", "origin", "git@gitlab.com:acme/demo.git");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: initial");
    const init = await repokeeper(dir, "init");
    expect(init.err).toBe("");
    expect(init.code).toBe(0);

    const ci = parse(await read(dir, ".gitlab-ci.yml"));
    expect(Object.keys(ci)).toEqual(["workflow", "go", "commits", "renovate", "release"]);
    expect(ci.go).toEqual({
      stage: "test",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
      image: "golang:${GO_VERSION}",
      // "stable" in the configuration is the image's latest tag
      parallel: { matrix: [{ GO_VERSION: ["latest"] }] },
      rules: [
        {
          if: '$CI_PIPELINE_SOURCE != "schedule" && $CI_COMMIT_TAG == null && ($CI_COMMIT_BRANCH == null || $CI_COMMIT_MESSAGE !~ /^chore\\(release\\): /)',
        },
      ],
      script: ['test -z "$(gofmt -l .)" || { gofmt -l .; exit 1; }', "go vet ./...", "go test ./..."],
    });

    // no version file in a Go module: nothing of npm's is bumped or committed
    const release = JSON.parse(await read(dir, ".releaserc.json"));
    const plugins = release.plugins.map((plugin: string | [string, unknown]) =>
      typeof plugin === "string" ? plugin : plugin[0],
    );
    expect(plugins).toEqual([
      "@semantic-release/commit-analyzer",
      "@semantic-release/release-notes-generator",
      "@semantic-release/changelog",
      "@semantic-release/git",
      "@semantic-release/gitlab",
    ]);
    expect(release.plugins[3][1].assets).toEqual(["CHANGELOG.md"]);

    const config = `${await read(dir, ".repokeeper.yml")}`.replace(
      "stack_options: {}",
      'stack_options:\n  go:\n    versions: ["1.24", stable]',
    );
    await writeFile(join(dir, ".repokeeper.yml"), config);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: sync");
    expect((await repokeeper(dir, "update")).code).toBe(0);
    expect(parse(await read(dir, ".gitlab-ci.yml")).go.parallel.matrix).toEqual([{ GO_VERSION: ["1.24", "latest"] }]);
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

  it("refuses a stack in a folder of its own before writing anything", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "backend"));
    await writeFile(join(dir, "backend/pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
    sh(dir, "init", "-q", "-b", "main");
    const init = await repokeeper(dir, "init", "--platform", "gitlab");
    expect(init.code).toBe(2);
    expect(init.err).toContain("(stack_options.python.directory) is not supported on gitlab yet");
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
