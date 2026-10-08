import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { run } from "../src/cli.js";
import { buildContext } from "../src/commands/context.js";
import { defaultConfig, type RepokeeperConfig, type StackId } from "../src/config/types.js";
import { ConfigError, UsageError } from "../src/errors.js";
import type { Output, ResolvedStack } from "../src/model.js";
import { planOutputs } from "../src/plan.js";
import { detectStackLayout } from "../src/stacks/index.js";
import { stackDirectory } from "../src/stacks/support.js";
import { capture, gitlabContext, makeContext, nodeResolved, tempDir } from "./helpers.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

const PACKAGE = `${JSON.stringify({ name: "web", version: "1.2.0", scripts: { test: "vitest run" }, devDependencies: { prettier: "^3.0.0" } }, null, 2)}\n`;
const GO_MOD = "module example.com/api\n\ngo 1.24\n";

function configFor(stacks: StackId[], options: RepokeeperConfig["stack_options"]): RepokeeperConfig {
  return {
    ...defaultConfig({
      stacks,
      standard: "1.0.0",
      copyright: "2026 Demo",
      contact: "https://example.com",
      codeowners: [],
    }),
    stack_options: options,
  };
}

const goResolved = (overrides: Partial<ResolvedStack> = {}): ResolvedStack => ({
  id: "go",
  staged: [{ name: "go:gofmt", glob: "*.go", run: "gofmt -w {staged_files}" }],
  test: "go test ./...",
  install: "go mod download",
  gitignore: ["Go"],
  dependabot: ["gomod"],
  ci: { workflow: "stack-go.yml", with: { "go-versions": '["stable"]', os: '["ubuntu-latest"]', commands: "[]" } },
  release: { type: "go", version: null },
  ...overrides,
});

function content(outputs: Output[], path: string): string {
  const output = outputs.find((o) => o.path === path && (o.kind === "file" || o.kind === "seed"));
  if (!output || !("content" in output)) throw new Error(`no file output for ${path}`);
  return output.content;
}

function yamlKey(outputs: Output[], path: string, key: string[]): unknown {
  const output = outputs.find((o) => o.kind === "yaml" && o.path === path && o.keyPath.join(".") === key.join("."));
  if (output?.kind !== "yaml") throw new Error(`no ${key.join(".")} in ${path}`);
  return output.value;
}

describe("stack directory option", () => {
  it("is a folder inside the repository, written any reasonable way", () => {
    expect(stackDirectory("go", {})).toBeUndefined();
    expect(stackDirectory("go", { directory: "backend" })).toBe("backend");
    expect(stackDirectory("go", { directory: "./apps/api/" })).toBe("apps/api");
    expect(stackDirectory("go", { directory: "apps\\api" })).toBe("apps/api");
    // the root, said explicitly
    expect(stackDirectory("go", { directory: "." })).toBeUndefined();
  });

  it("refuses a folder outside the repository and a value that is not a folder name", () => {
    for (const directory of ["../other", "/abs", "C:/abs", "a/../../b", "", 7, ["backend"]]) {
      expect(() => stackDirectory("go", { directory })).toThrow(ConfigError);
    }
    expect(() => stackDirectory("go", { directory: "../other" })).toThrow(
      ".repokeeper.yml: stack_options.go.directory must be a folder inside the repository, such as backend or apps/api",
    );
  });
});

describe("resolving stacks in folders", () => {
  it("reads each stack from its own folder and keeps the stack's other options", async () => {
    const root = await repoWith({
      "frontend/package.json": PACKAGE,
      "frontend/package-lock.json": "{}",
      "backend/go.mod": GO_MOD,
    });
    const ctx = await buildContext(
      root,
      configFor(["node", "go"], { node: { directory: "frontend", versions: [24] }, go: { directory: "backend" } }),
      { owner: "demo", name: "mono" },
    );

    const [node, go] = ctx.stacks;
    expect(node?.directory).toBe("frontend");
    expect(node?.test).toBe("npm test");
    expect(node?.release.version).toBe("1.2.0");
    expect(node?.ci?.with["node-versions"]).toBe('["24"]');
    // the lockfile was found in the folder, not looked for at the root
    expect(node?.ci?.with["install-command"]).toBe("npm ci");
    expect(go?.directory).toBe("backend");
  });

  it("says which folder is missing, and that GitLab cannot do this yet", async () => {
    const root = await repoWith({ "frontend/package.json": PACKAGE });
    await expect(
      buildContext(root, configFor(["go"], { go: { directory: "backend" } }), { owner: "demo", name: "mono" }),
    ).rejects.toThrow(".repokeeper.yml: stack_options.go.directory: the folder backend does not exist");

    const gitlab = { ...configFor(["node"], { node: { directory: "frontend" } }), platform: "gitlab" as const };
    await expect(buildContext(root, gitlab, { owner: "demo", name: "mono" })).rejects.toThrow(UsageError);
    await expect(buildContext(root, gitlab, { owner: "demo", name: "mono" })).rejects.toThrow(
      "a stack in a folder of its own (stack_options.node.directory) is not supported on gitlab yet",
    );
  });
});

describe("outputs for stacks in folders", () => {
  const ctx = makeContext({
    stacks: [nodeResolved({ directory: "frontend" }), goResolved({ directory: "backend" })],
    config: { stacks: ["node", "go"] },
  });
  const outputs = planOutputs(ctx);

  it("runs each CI job in the stack's folder", () => {
    const node = yamlKey(outputs, ".github/workflows/ci.yml", ["jobs", "node"]) as { with: Record<string, string> };
    const go = yamlKey(outputs, ".github/workflows/ci.yml", ["jobs", "go"]) as { with: Record<string, string> };
    expect(node.with["working-directory"]).toBe("frontend");
    expect(node.with["install-command"]).toBe("npm ci");
    expect(go.with["working-directory"]).toBe("backend");
  });

  it("gives each hook the folder to run in, so it only sees that folder's staged files", () => {
    const hooks = parse(content(outputs, "lefthook.yml"));
    expect(hooks["pre-commit"].jobs).toEqual([
      {
        name: "node:prettier",
        glob: "*.{js,ts}",
        run: "npx prettier --write --ignore-unknown {staged_files}",
        root: "frontend/",
        stage_fixed: true,
      },
      { name: "go:gofmt", glob: "*.go", run: "gofmt -w {staged_files}", root: "backend/", stage_fixed: true },
    ]);
    expect(hooks["pre-push"].jobs).toEqual([
      { name: "node:test", run: "npm test", root: "frontend/" },
      { name: "go:test", run: "go test ./...", root: "backend/" },
    ]);
    // no package.json at the root to install commitlint from
    expect(hooks["commit-msg"].jobs[0].run).toMatch(/^npx --yes --package @commitlint\/cli@/);
  });

  it("does not write repokeeper's tools into a package.json that is not the repository's", () => {
    expect(outputs.filter((output) => output.kind === "json")).toEqual([]);
  });

  it("points Dependabot at each folder and keeps the workflows at the root", () => {
    const dependabot = parse(content(outputs, ".github/dependabot.yml"));
    expect(dependabot.updates.map((u: Record<string, string>) => [u["package-ecosystem"], u.directory])).toEqual([
      ["npm", "/frontend"],
      ["gomod", "/backend"],
      ["github-actions", "/"],
    ]);
  });

  it("releases the first language stack from its folder", () => {
    const config = JSON.parse(content(outputs, "release-please-config.json"));
    expect(Object.keys(config.packages)).toEqual(["frontend"]);
    expect(config.packages.frontend["release-type"]).toBe("node");
    expect(JSON.parse(content(outputs, ".release-please-manifest.json"))).toEqual({ frontend: "1.0.0" });
  });

  it("puts release markers in the file where it is in the repository", () => {
    const kotlin = goResolved({
      id: "kotlin",
      directory: "android",
      release: {
        type: "simple",
        version: "1.0.0",
        versionLine: { path: "gradle.properties", line: "^version=" },
        extraFiles: ["gradle.properties"],
      },
    });
    const planned = planOutputs(makeContext({ stacks: [kotlin], config: { stacks: ["kotlin"] } }));
    expect(planned.find((output) => output.kind === "marker")?.path).toBe("android/gradle.properties");
    // release-please resolves extra files against the package folder itself
    expect(JSON.parse(content(planned, "release-please-config.json")).packages.android["extra-files"]).toEqual([
      "gradle.properties",
    ]);
  });

  it("tells contributors where to run each install command", () => {
    const contributing = content(outputs, "CONTRIBUTING.md");
    expect(contributing).toContain("`cd frontend && npm install`");
    expect(contributing).toContain("`cd backend && go mod download`");
    expect(contributing).toContain("lefthook@");
  });

  it("leaves a repository whose stacks are at the root exactly as before", () => {
    const flat = planOutputs(makeContext());
    const node = yamlKey(flat, ".github/workflows/ci.yml", ["jobs", "node"]) as { with: Record<string, string> };
    expect(node.with).not.toHaveProperty("working-directory");
    expect(parse(content(flat, "lefthook.yml"))["pre-commit"].jobs[0]).not.toHaveProperty("root");
    expect(Object.keys(JSON.parse(content(flat, "release-please-config.json")).packages)).toEqual(["."]);
    expect(flat.some((output) => output.kind === "json" && output.path === "package.json")).toBe(true);
  });

  it("has no folder support on GitLab to render", () => {
    // the adapter is only reached with stacks at the root; buildContext turns folders away first
    expect(gitlabContext().platform.id).toBe("gitlab");
  });
});

describe("detecting a monorepo", () => {
  it("looks in the folders only when the root holds no project", async () => {
    const mono = await repoWith({ "frontend/package.json": "{}", "backend/go.mod": GO_MOD, "README.md": "" });
    expect(await detectStackLayout(mono)).toEqual({
      stacks: ["node", "go"],
      directories: { node: "frontend", go: "backend" },
      skipped: [],
    });

    const rooted = await repoWith({ "package.json": "{}", "backend/go.mod": GO_MOD });
    expect(await detectStackLayout(rooted)).toEqual({ stacks: ["node"], directories: {}, skipped: [] });
  });

  it("takes the first folder of a stack and reports the others", async () => {
    const dir = await repoWith({ "admin/package.json": "{}", "web/package.json": "{}", "api/go.mod": GO_MOD });
    expect(await detectStackLayout(dir)).toEqual({
      stacks: ["node", "go"],
      directories: { node: "admin", go: "api" },
      skipped: [{ stack: "node", directory: "web" }],
    });
  });

  it("ignores samples, build output, hidden folders, and scripts beside real projects", async () => {
    const dir = await repoWith({
      "examples/package.json": "{}",
      "node_modules/x/package.json": "{}",
      ".cache/package.json": "{}",
      "docs/package.json": "{}",
      "service/go.mod": GO_MOD,
      "scripts/deploy.sh": "",
    });
    expect(await detectStackLayout(dir)).toEqual({ stacks: ["go"], directories: { go: "service" }, skipped: [] });
    expect(await detectStackLayout(await repoWith({ "scripts/deploy.sh": "" }))).toEqual({
      stacks: ["script"],
      // a scripts/ folder is how a script-only repository is laid out, so it counts as the root
      directories: {},
      skipped: [],
    });
    expect((await detectStackLayout(await repoWith({ "README.md": "" }))).stacks).toEqual([]);
  });
});

describe("monorepo end to end", () => {
  async function repokeeper(dir: string, ...args: string[]) {
    const c = capture(dir);
    const code = await run(args, c.io);
    return { code, out: c.out.join("\n"), err: c.err.join("\n") };
  }

  async function monorepo(): Promise<string> {
    const dir = await repoWith({
      "frontend/package.json": PACKAGE,
      "backend/go.mod": GO_MOD,
      "backend/main.go": "package main\n",
    });
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.name", "Demo User");
    sh(dir, "config", "user.email", "demo@example.com");
    sh(dir, "config", "core.autocrlf", "false");
    sh(dir, "remote", "add", "origin", "https://github.com/demo-owner/mono.git");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: initial");
    return dir;
  }

  it("init finds both projects, writes their folders to the config, and check agrees", async () => {
    const dir = await monorepo();
    const init = await repokeeper(dir, "init");
    expect(init.err).toBe("");
    expect(init.code).toBe(0);
    expect(init.out).toContain("found node in frontend/");
    expect(init.out).toContain("found go in backend/");

    const config = parse(await readFile(join(dir, ".repokeeper.yml"), "utf8"));
    expect(config.stacks).toEqual(["node", "go"]);
    expect(config.stack_options).toEqual({ node: { directory: "frontend" }, go: { directory: "backend" } });

    const ci = parse(await readFile(join(dir, ".github/workflows/ci.yml"), "utf8"));
    expect(ci.jobs.node.with["working-directory"]).toBe("frontend");
    expect(ci.jobs.go.with["working-directory"]).toBe("backend");
    // nothing of repokeeper's lands in the project's own package.json, and none is created at the root
    expect(await readFile(join(dir, "frontend/package.json"), "utf8")).toBe(PACKAGE);
    expect(existsSync(join(dir, "package.json"))).toBe(false);

    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: sync");
    const check = await repokeeper(dir, "check");
    expect(check.code).toBe(0);
    expect((await repokeeper(dir, "update")).code).toBe(0);
  });

  it("takes the folder on the command line as --stack id:folder", async () => {
    const dir = await monorepo();
    const init = await repokeeper(dir, "init", "--stack", "go:backend/", "--dry-run");
    expect(init.code).toBe(0);
    expect(init.out).toContain("found go in backend/");
    expect(init.out).not.toContain("found node");

    const unknown = await repokeeper(dir, "init", "--stack", "cobol:legacy");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown stack cobol");
  });
});
