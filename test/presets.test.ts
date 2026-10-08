import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { run } from "../src/cli.js";
import { applyPreset } from "../src/commands/presets.js";
import { defaultConfig } from "../src/config/types.js";
import { capture, tempDir } from "./helpers.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

const base = (platform: "github" | "gitlab" = "github") =>
  defaultConfig({
    stacks: ["node"],
    standard: "1.0.0",
    copyright: "2026 Demo",
    contact: "https://example.com",
    codeowners: ["@demo"],
    platform,
  });

async function nodeRepo(): Promise<string> {
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
  return dir;
}

/** Runs the CLI as in a terminal: `answers` are given to the yes/no questions in order; Enter is `undefined`. */
async function repokeeper(dir: string, args: string[], answers?: Array<boolean | undefined>) {
  const c = capture(dir);
  const asked: string[] = [];
  const io = answers
    ? {
        ...c.io,
        confirm: async (question: string, fallback = false) => {
          asked.push(question);
          const answer = answers[asked.length - 1];
          return answer === undefined ? fallback : answer;
        },
      }
    : c.io;
  const code = await run(args, io);
  return { code, out: c.out.join("\n"), err: c.err.join("\n"), asked };
}

describe("presets", () => {
  it("standard is the configuration init has always written", () => {
    expect(applyPreset(base(), "standard")).toEqual(base());
  });

  it("essential keeps editor settings, .gitignore and CI", () => {
    expect(applyPreset(base(), "essential").modules).toEqual({
      editorconfig: true,
      gitignore: true,
      ci: true,
      commits: false,
      hooks: false,
      release: false,
      deps: false,
      drift: false,
      health: false,
    });
    expect(applyPreset(base(), "essential").github).toBeUndefined();
  });

  it("strict adds the drift check and, on GitHub, protection that requires a review", () => {
    const strict = applyPreset({ ...base(), github: { default_branch: "trunk" } }, "strict");
    expect(strict.modules).toEqual({ ...base().modules, drift: true });
    expect(strict.github).toEqual({
      default_branch: "trunk",
      security: { dependabot_alerts: true, dependabot_security_updates: true },
      protect: {
        require_pull_request: true,
        required_approvals: 1,
        allow_force_push: false,
        required_checks: ["commits / commitlint"],
      },
    });
    // GitLab has no repository settings repokeeper manages
    const gitlab = applyPreset(base("gitlab"), "strict");
    expect(gitlab.modules.drift).toBe(true);
    expect(gitlab.github).toBeUndefined();
  });
});

describe("init --preset", () => {
  it("essential writes only the basics, and the repository then checks clean", async () => {
    const dir = await nodeRepo();
    const init = await repokeeper(dir, ["init", "--preset", "essential"]);
    expect(init.err).toBe("");
    expect(init.code).toBe(0);

    for (const file of [".editorconfig", ".gitignore", ".github/workflows/ci.yml"]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    for (const file of [
      "lefthook.yml",
      "commitlint.config.mjs",
      "release-please-config.json",
      ".github/dependabot.yml",
      "CONTRIBUTING.md",
      "LICENSE",
    ]) {
      expect(existsSync(join(dir, file)), file).toBe(false);
    }
    const ci = parse(await readFile(join(dir, ".github/workflows/ci.yml"), "utf8"));
    expect(Object.keys(ci.jobs)).toEqual(["node"]);
    // nothing of repokeeper's tools in package.json when hooks and commit linting are off
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).devDependencies).toEqual({
      prettier: "^3.0.0",
    });
    expect(parse(await readFile(join(dir, ".repokeeper.yml"), "utf8")).modules.health).toBe(false);

    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: apply standard");
    expect((await repokeeper(dir, ["check"])).code).toBe(0);
  });

  it("strict writes the settings into the config and says how to apply them", async () => {
    const dir = await nodeRepo();
    const init = await repokeeper(dir, ["init", "--preset", "strict"]);
    expect(init.code).toBe(0);
    expect(init.out).toContain(
      "next: run `repokeeper github apply` to put the branch protection and security settings in place",
    );
    const config = parse(await readFile(join(dir, ".repokeeper.yml"), "utf8"));
    expect(config.modules.drift).toBe(true);
    expect(config.github.protect.required_approvals).toBe(1);
    const ci = parse(await readFile(join(dir, ".github/workflows/ci.yml"), "utf8"));
    expect(Object.keys(ci.jobs).sort()).toEqual(["commits", "node", "repokeeper"]);
  });

  it("the default run prints nothing new and asks nothing", async () => {
    const dir = await nodeRepo();
    const init = await repokeeper(dir, ["init"], []);
    expect(init.code).toBe(0);
    expect(init.asked).toEqual([]);
    expect(init.out).not.toContain("github apply");
  });

  it("refuses an unknown preset and the flags on another command", async () => {
    const dir = await nodeRepo();
    const unknown = await repokeeper(dir, ["init", "--preset", "enterprise"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown preset enterprise; expected one of essential, standard, strict");
    const misplaced = await repokeeper(dir, ["check", "--preset", "strict"]);
    expect(misplaced.code).toBe(2);
    expect(misplaced.err).toContain("--preset and --interactive are only for init");
  });
});

describe("init --interactive", () => {
  // the modules are asked about in this order, then the write is confirmed
  const QUESTIONS = [
    "Apply editorconfig?",
    "Apply gitignore?",
    "Apply commits?",
    "Apply hooks?",
    "Apply ci?",
    "Apply release?",
    "Apply deps?",
    "Apply health?",
    "Apply drift?",
    "Write these files?",
  ];

  it("names the files of each part, takes the answers, and writes only what was chosen", async () => {
    const dir = await nodeRepo();
    //                                         editor     ignore     commits hooks  ci         release deps       health     drift      write
    const init = await repokeeper(
      dir,
      ["init", "--interactive"],
      [undefined, undefined, true, false, undefined, false, undefined, undefined, undefined, true],
    );
    expect(init.err).toBe("");
    expect(init.code).toBe(0);
    expect(init.asked).toEqual(QUESTIONS);
    // each question was preceded by what that part would write
    expect(init.out).toContain("hooks:\n  lefthook.yml");
    expect(init.out).toContain("release:\n  .github/workflows/release.yml");
    expect(init.out).toContain("a job that fails a pull request when a managed file was edited by hand");

    const config = parse(await readFile(join(dir, ".repokeeper.yml"), "utf8"));
    expect(config.modules).toMatchObject({ commits: true, hooks: false, ci: true, release: false, deps: true });
    // Enter on drift keeps the standard preset's answer, which is no
    expect(config.modules.drift).toBe(false);
    expect(existsSync(join(dir, "lefthook.yml"))).toBe(false);
    expect(existsSync(join(dir, "release-please-config.json"))).toBe(false);
    expect(existsSync(join(dir, "commitlint.config.mjs"))).toBe(true);
    expect(existsSync(join(dir, ".github/dependabot.yml"))).toBe(true);
  });

  it("starts from the preset: Enter all the way through essential keeps it essential", async () => {
    const dir = await nodeRepo();
    const init = await repokeeper(dir, ["init", "-i", "--preset", "essential"], new Array(10).fill(undefined));
    expect(init.code).toBe(0);
    expect(init.asked).toEqual(QUESTIONS);
    expect(existsSync(join(dir, "lefthook.yml"))).toBe(false);
    expect(existsSync(join(dir, ".github/workflows/ci.yml"))).toBe(true);
    // a part the preset left out can still be taken, with its usual settings
    const other = await nodeRepo();
    const answers = new Array(10).fill(undefined);
    answers[7] = true;
    await repokeeper(other, ["init", "-i", "--preset", "essential"], answers);
    expect(parse(await readFile(join(other, ".repokeeper.yml"), "utf8")).modules.health.license).toBe("MIT");
    expect(existsSync(join(other, "CONTRIBUTING.md"))).toBe(true);
  });

  it("writes nothing when the last question is answered no", async () => {
    const dir = await nodeRepo();
    const answers = new Array(10).fill(undefined);
    answers[9] = false;
    const init = await repokeeper(dir, ["init", "--interactive"], answers);
    expect(init.code).toBe(0);
    expect(init.out).toContain("nothing written");
    expect(existsSync(join(dir, ".repokeeper.yml"))).toBe(false);
    expect(existsSync(join(dir, "lefthook.yml"))).toBe(false);
  });

  it("with --dry-run asks about the parts and shows the result without the last question", async () => {
    const dir = await nodeRepo();
    const init = await repokeeper(dir, ["init", "--interactive", "--dry-run"], new Array(9).fill(undefined));
    expect(init.code).toBe(0);
    expect(init.asked).toEqual(QUESTIONS.slice(0, 9));
    expect(init.out).toContain("dry run: nothing written");
    expect(existsSync(join(dir, ".repokeeper.yml"))).toBe(false);
  });

  it("needs a terminal", async () => {
    const dir = await nodeRepo();
    const init = await repokeeper(dir, ["init", "--interactive"]);
    expect(init.code).toBe(2);
    expect(init.err).toContain("--interactive needs a terminal to ask its questions in");
    expect(existsSync(join(dir, ".repokeeper.yml"))).toBe(false);
  });
});
