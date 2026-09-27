import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import type { GitHubApi } from "../src/github/api.js";
import { capture, tempDir } from "./helpers.js";

const CONFIG =
  "schema: 1\nstandard: 1.2.2\nplatform: github\nstacks: [node]\nmodules:\n  health: false\ngithub:\n  merge:\n    rebase: false\n  topics: [cli]\n";

async function repo(config = CONFIG): Promise<string> {
  const dir = await tempDir();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd: dir });
  await writeFile(join(dir, ".repokeeper.yml"), config);
  return dir;
}

function fakeApi() {
  const writes: string[] = [];
  const api: GitHubApi = {
    async request(method, path) {
      if (method !== "GET") {
        writes.push(`${method} ${path}`);
        return { status: 200, data: {} };
      }
      if (path === "/repos/o/r") return { status: 200, data: { allow_rebase_merge: true } };
      if (path === "/repos/o/r/topics") return { status: 200, data: { names: [] } };
      return { status: 404, data: { message: "Not Found" } };
    },
  };
  return { api, writes };
}

async function githubApply(dir: string, args: string[], confirm?: boolean) {
  const { api, writes } = fakeApi();
  const c = capture(dir);
  const io = { ...c.io, githubApi: api, ...(confirm === undefined ? {} : { confirm: async () => confirm }) };
  const code = await run(["github", "apply", ...args], io);
  return { code, out: c.out.join("\n"), err: c.err.join("\n"), writes };
}

describe("repokeeper github apply", () => {
  it("previews the changes on a dry run", async () => {
    const result = await githubApply(await repo(), ["--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("change     merge.rebase: true -> false");
    expect(result.out).toContain("change     topics: (none) -> cli");
    expect(result.writes).toEqual([]);
  });

  it("applies nothing without --yes when nobody can confirm, or when the answer is no", async () => {
    const silent = await githubApply(await repo(), []);
    expect(silent.code).toBe(1);
    expect(silent.out).toContain("nothing applied; pass --yes to apply");
    expect(silent.writes).toEqual([]);
    expect((await githubApply(await repo(), [], false)).writes).toEqual([]);
  });

  it("applies after confirmation or with --yes", async () => {
    const confirmed = await githubApply(await repo(), [], true);
    expect(confirmed.writes).toEqual(["PATCH /repos/o/r", "PUT /repos/o/r/topics"]);
    const yes = await githubApply(await repo(), ["--yes"]);
    expect(yes.code).toBe(0);
    expect(yes.out).toContain("applied    topics");
  });

  it("reports matching settings and rejects other subcommands", async () => {
    const matching = await githubApply(
      await repo(CONFIG.replace(/github:[\s\S]*$/, "github:\n  default_branch: main\n")),
      [],
    );
    expect(matching.out).toBe("GitHub settings of o/r match .repokeeper.yml");
    expect(await run(["github", "sync"], capture().io)).toBe(2);
  });
});
