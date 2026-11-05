import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { run } from "../src/cli.js";
import { loadConfig, parseConfig } from "../src/config/load.js";
import { ApiError, ConfigError } from "../src/errors.js";
import type { ApiResponse, GitHubApi } from "../src/github/api.js";
import { STANDARD_VERSION } from "../src/version.js";
import { capture, tempDir } from "./helpers.js";

const OWN = "schema: 1\nstandard: 1.0.0\n";
const TOP = "platform: github\nstacks: [node]\n";
const BASE = `${TOP}modules:\n  health: false\n`;

/** Writes `files` under a fresh folder; the repository is its `repo/` subfolder. */
async function layout(files: Record<string, string>): Promise<string> {
  const top = await tempDir();
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(top, path)), { recursive: true });
    await writeFile(join(top, path), text);
  }
  return join(top, "repo");
}

async function errorOf(load: Promise<unknown>): Promise<string> {
  try {
    await load;
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a ConfigError");
}

const file = (text: string): ApiResponse => ({
  status: 200,
  data: { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") },
});

function fakeGithub(responses: Record<string, ApiResponse | Error>) {
  const asked: string[] = [];
  const api: GitHubApi = {
    async request(method, path) {
      asked.push(`${method} ${path}`);
      const response = responses[path] ?? { status: 404, data: { message: "Not Found" } };
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { api, asked };
}

describe("extends: merging", () => {
  it("merges mappings key by key, replaces lists and scalars, and lets the repository's file win", async () => {
    const root = await layout({
      "org/base.yml": `${TOP}modules:\n  ci: false\n  deps: false\n  health: false\ngithub:\n  topics: [a, b]\n  merge:\n    rebase: false\n`,
      "repo/.repokeeper.yml": `extends: ../org/base.yml\n${OWN}modules:\n  deps: true\ngithub:\n  topics: [c]\n`,
    });
    const config = await loadConfig(root);
    expect(config.platform).toBe("github");
    expect(config.stacks).toEqual(["node"]);
    expect(config.modules.ci).toBe(false);
    expect(config.modules.deps).toBe(true);
    expect(config.github?.topics).toEqual(["c"]);
    expect(config.github?.merge).toEqual({ rebase: false });
    expect(config).not.toHaveProperty("extends");
  });

  it("lets a later source override an earlier one, and takes a single string as well as a list", async () => {
    const root = await layout({
      "org/a.yml": `${TOP}modules:\n  ci: false\n  deps: false\n  health: false\n`,
      "org/b.yml": "modules:\n  ci: true\n",
      "repo/.repokeeper.yml": `extends: [../org/a.yml, ../org/b.yml]\n${OWN}`,
    });
    const config = await loadConfig(root);
    expect(config.modules.ci).toBe(true);
    expect(config.modules.deps).toBe(false);
  });

  it("replaces a mapping with a value of another kind, such as health: false", async () => {
    const root = await layout({
      "org/base.yml": `${TOP}modules:\n  health: { license: MIT, copyright: x, contact: y, codeowners: ["@o"] }\n`,
      "repo/.repokeeper.yml": `extends: ../org/base.yml\n${OWN}modules:\n  health: false\n`,
    });
    expect((await loadConfig(root)).modules.health).toBe(false);
  });

  it("resolves a chain depth first, each path relative to the file that names it", async () => {
    const root = await layout({
      "org/base.yml": `${TOP}modules:\n  ci: false\n  deps: false\n  health: false\n`,
      "org/group/web.yml": "extends: ../base.yml\nmodules:\n  ci: true\n",
      "repo/.repokeeper.yml": `extends: ../org/group/web.yml\n${OWN}`,
    });
    const config = await loadConfig(root);
    expect(config.modules.ci).toBe(true);
    expect(config.modules.deps).toBe(false);
  });

  it("merges a file two others extend once, where it is first reached", async () => {
    const root = await layout({
      "org/base.yml": `${TOP}modules:\n  ci: false\n  health: false\n`,
      "org/a.yml": "extends: base.yml\nmodules:\n  ci: true\n",
      "org/b.yml": "extends: base.yml\nowned: [x]\n",
      "repo/.repokeeper.yml": `extends: [../org/a.yml, ../org/b.yml]\n${OWN}`,
    });
    const config = await loadConfig(root);
    expect(config.modules.ci).toBe(true);
    expect(config.owned).toEqual(["x"]);
  });
});

describe("extends: chains that cannot be read", () => {
  it("names the circle", async () => {
    const root = await layout({
      "org/a.yml": "extends: b.yml\n",
      "org/b.yml": "extends: a.yml\n",
      "repo/.repokeeper.yml": `extends: ../org/a.yml\n${OWN}`,
    });
    expect(await errorOf(loadConfig(root))).toBe(
      "../org/b.yml:1: extends goes round in a circle: ../org/a.yml -> ../org/b.yml -> ../org/a.yml",
    );
  });

  it("refuses a file that extends itself", async () => {
    const root = await layout({ "repo/.repokeeper.yml": `${OWN}extends: ./.repokeeper.yml\n` });
    expect(await errorOf(loadConfig(root))).toBe(
      ".repokeeper.yml:3: extends goes round in a circle: .repokeeper.yml -> .repokeeper.yml",
    );
  });

  it("allows five files deep and refuses a sixth", async () => {
    const chain = (depth: number) => {
      const files: Record<string, string> = { "repo/.repokeeper.yml": `extends: ../org/f1.yml\n${OWN}` };
      for (let n = 1; n <= depth; n++) files[`org/f${n}.yml`] = n < depth ? `extends: f${n + 1}.yml\n` : BASE;
      return files;
    };
    expect((await loadConfig(await layout(chain(5)))).stacks).toEqual(["node"]);
    expect(await errorOf(loadConfig(await layout(chain(6))))).toMatch(
      /^\.\.\/org\/f5\.yml:1: extends goes more than 5 files deep: \.repokeeper\.yml -> \.\.\/org\/f1\.yml -> .* -> \.\.\/org\/f6\.yml$/,
    );
  });

  it("names a missing file and the line that names it", async () => {
    const root = await layout({ "repo/.repokeeper.yml": `${OWN}extends:\n  - ../org/missing.yml\n` });
    expect(await errorOf(loadConfig(root))).toBe(".repokeeper.yml:4: cannot read ../org/missing.yml: no such file");
  });

  it("refuses an extends that is not a path or a list of them", async () => {
    const root = await layout({ "repo/.repokeeper.yml": `${OWN}extends: 3\n` });
    expect(await errorOf(loadConfig(root))).toMatch(/^\.repokeeper\.yml:3: extends must be a path/);
  });

  it("refuses a base that sets the standard", async () => {
    const root = await layout({
      "org/base.yml": `${BASE}standard: 1.0.0\n`,
      "repo/.repokeeper.yml": `extends: ../org/base.yml\n${OWN}`,
    });
    expect(await errorOf(loadConfig(root))).toMatch(/^\.\.\/org\/base\.yml:5: standard is not inherited/);
  });

  it("is not resolved by parseConfig, which has no folder to look in", () => {
    expect(() => parseConfig(`${OWN}extends: base.yml\n`)).toThrow(
      ".repokeeper.yml:3: extends is resolved only when the file is read from disk",
    );
  });
});

describe("extends: validation of the merged result", () => {
  it("accepts bases that are not complete on their own", async () => {
    const root = await layout({
      "org/a.yml": "platform: github\n",
      "org/b.yml": "modules:\n  health: false\n",
      "repo/.repokeeper.yml": `extends: [../org/a.yml, ../org/b.yml]\n${OWN}stacks: [node]\n`,
    });
    expect((await loadConfig(root)).modules.health).toBe(false);
  });

  it("names the repository's file when a required key is missing from all of them", async () => {
    const root = await layout({
      "org/a.yml": "platform: github\nmodules:\n  health: false\n",
      "repo/.repokeeper.yml": `extends: ../org/a.yml\n${OWN}`,
    });
    expect(await errorOf(loadConfig(root))).toBe(".repokeeper.yml:1: (root) must have required property 'stacks'");
  });

  it("names the file and line an invalid inherited key came from", async () => {
    const root = await layout({
      "org/a.yml": `${BASE}  hoks: true\n`,
      "repo/.repokeeper.yml": `extends: ../org/a.yml\n${OWN}`,
    });
    expect(await errorOf(loadConfig(root))).toBe("../org/a.yml:5: modules.hoks is not a known key");
  });

  it("names the file a replaced list came from", async () => {
    const root = await layout({
      "org/a.yml": `${BASE}owned: [a]\n`,
      "repo/.repokeeper.yml": `extends: ../org/a.yml\n${OWN}owned:\n  - b\n  - ""\n`,
    });
    expect(await errorOf(loadConfig(root))).toBe(".repokeeper.yml:6: owned.1 must NOT have fewer than 1 characters");
  });

  it("names the base that sets the other platform's key", async () => {
    const root = await layout({
      "org/a.yml": `${BASE}gitlab:\n  default_branch: trunk\n`,
      "repo/.repokeeper.yml": `extends: ../org/a.yml\n${OWN}`,
    });
    expect(await errorOf(loadConfig(root))).toBe("../org/a.yml:6: gitlab is not used on the github platform");
  });
});

describe("extends: github sources", () => {
  const PATH = "/repos/acme/standards/contents/repokeeper/base.yml";

  it("fetches the file at the ref, and a relative path in it from the same repository and ref", async () => {
    const { api, asked } = fakeGithub({
      [`${PATH}?ref=v2`]: file("extends: common.yml\nmodules:\n  ci: false\n  health: false\n"),
      "/repos/acme/standards/contents/repokeeper/common.yml?ref=v2": file(`${TOP}modules:\n  deps: false\n`),
    });
    const root = await layout({
      "repo/.repokeeper.yml": `extends: github:acme/standards/repokeeper/base.yml@v2\n${OWN}`,
    });
    const config = await loadConfig(root, api);
    expect(asked).toEqual([`GET ${PATH}?ref=v2`, "GET /repos/acme/standards/contents/repokeeper/common.yml?ref=v2"]);
    expect(config.modules.ci).toBe(false);
    expect(config.modules.deps).toBe(false);
    expect(config.stacks).toEqual(["node"]);
  });

  it("reads the default branch when no ref is given", async () => {
    const { api, asked } = fakeGithub({ [PATH]: file(BASE) });
    const root = await layout({ "repo/.repokeeper.yml": `extends: github:acme/standards/repokeeper/base.yml\n${OWN}` });
    expect((await loadConfig(root, api)).platform).toBe("github");
    expect(asked).toEqual([`GET ${PATH}`]);
  });

  it("names the source and line of an invalid inherited key", async () => {
    const { api } = fakeGithub({ [`${PATH}?ref=main`]: file(`${BASE}  hoks: true\n`) });
    const root = await layout({
      "repo/.repokeeper.yml": `extends: github:acme/standards/repokeeper/base.yml@main\n${OWN}`,
    });
    expect(await errorOf(loadConfig(root, api))).toBe(
      "github:acme/standards/repokeeper/base.yml@main:5: modules.hoks is not a known key",
    );
  });

  it("refuses a relative path that leaves the repository", async () => {
    const { api } = fakeGithub({ [`${PATH}?ref=v2`]: file("extends: ../../outside.yml\n") });
    const root = await layout({
      "repo/.repokeeper.yml": `extends: github:acme/standards/repokeeper/base.yml@v2\n${OWN}`,
    });
    expect(await errorOf(loadConfig(root, api))).toBe(
      "github:acme/standards/repokeeper/base.yml@v2:1: ../../outside.yml is outside acme/standards; name it as a github: source",
    );
  });

  it("refuses a source it cannot parse", async () => {
    const root = await layout({ "repo/.repokeeper.yml": `extends: github:acme/standards\n${OWN}` });
    expect(await errorOf(loadConfig(root, fakeGithub({}).api))).toBe(
      ".repokeeper.yml:1: github:acme/standards is not a github:owner/repo/path/to/file.yml[@ref] source",
    );
  });

  it.each([
    [{ status: 404, data: { message: "Not Found" } }, "GitHub found no such repository, file or ref"],
    [{ status: 403, data: { message: "API rate limit exceeded" } }, "GitHub answered 403 (API rate limit exceeded)"],
    [{ status: 401, data: { message: "Bad credentials" } }, "GitHub refused the token (Bad credentials)"],
    [{ status: 200, data: [{ name: "base.yml" }] }, "it is not a file"],
    [new ApiError("GitHub API GET /x failed: fetch failed"), "fetch failed; check the network connection"],
  ])("explains a fetch that fails (%#), naming the source", async (response, reason) => {
    const { api } = fakeGithub({ [`${PATH}?ref=v2`]: response });
    const root = await layout({
      "repo/.repokeeper.yml": `extends: github:acme/standards/repokeeper/base.yml@v2\n${OWN}`,
    });
    const message = await errorOf(loadConfig(root, api));
    expect(message).toMatch(/^\.repokeeper\.yml:1: cannot read github:acme\/standards\/repokeeper\/base\.yml@v2: /);
    expect(message).toContain(reason);
  });
});

describe("extends: commands that rewrite .repokeeper.yml", () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

  async function repokeeper(dir: string, ...args: string[]) {
    const c = capture(dir);
    const code = await run(args, c.io);
    return { code, out: c.out.join("\n"), err: c.err.join("\n") };
  }

  /** A repository on the standard whose platform, stacks and modules come from ../org/base.yml. */
  async function inheritingRepo(): Promise<{ dir: string; base: string; own: string }> {
    const dir = await layout({
      "repo/package.json": `${JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }, null, 2)}\n`,
    });
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.name", "Demo User");
    sh(dir, "config", "user.email", "demo@example.com");
    sh(dir, "config", "core.autocrlf", "false");
    sh(dir, "remote", "add", "origin", "https://github.com/demo-owner/demo.git");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: initial");
    const init = await repokeeper(dir, "init");
    expect(init.err).toBe("");
    expect(init.code).toBe(0);
    const { platform, stacks, modules } = parse(await readFile(join(dir, ".repokeeper.yml"), "utf8"));
    const base = stringify({ platform, stacks, modules });
    await mkdir(join(dir, "../org"));
    await writeFile(join(dir, "../org/base.yml"), base);
    // an older standard, so that update has the line to move
    const own = "# this repository's own settings\nextends: ../org/base.yml\nschema: 1\nstandard: 1.0.0\n";
    await writeFile(join(dir, ".repokeeper.yml"), own);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: apply standard");
    return { dir, base, own };
  }

  it("update moves only the standard line and inlines nothing it inherited", async () => {
    const { dir, base, own } = await inheritingRepo();
    expect((await repokeeper(dir, "check")).code).toBe(1);
    const update = await repokeeper(dir, "update");
    expect(update.err).toBe("");
    expect(update.code).toBe(0);
    expect(await readFile(join(dir, ".repokeeper.yml"), "utf8")).toBe(
      own.replace("standard: 1.0.0", `standard: ${STANDARD_VERSION}`),
    );
    expect(await readFile(join(dir, "../org/base.yml"), "utf8")).toBe(base);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: update");
    expect((await repokeeper(dir, "check")).code).toBe(0);
  });

  it("eject adds only the workflow source to the repository's file", async () => {
    const { dir, base, own } = await inheritingRepo();
    const eject = await repokeeper(dir, "eject");
    expect(eject.err).toBe("");
    expect(eject.code).toBe(0);
    const written = await readFile(join(dir, ".repokeeper.yml"), "utf8");
    expect(parse(written)).toEqual({
      ...parse(own),
      standard: STANDARD_VERSION,
      github: { workflows: { source: "local" } },
    });
    expect(written).toContain("# this repository's own settings");
    expect(await readFile(join(dir, "../org/base.yml"), "utf8")).toBe(base);
  });
});
