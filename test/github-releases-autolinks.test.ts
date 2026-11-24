import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { parseConfig } from "../src/config/load.js";
import type { ApiResponse, GitHubApi } from "../src/github/api.js";
import { type Autolink, planGithub } from "../src/github/settings.js";
import { capture, tempDir } from "./helpers.js";

interface AutolinkRecord {
  id: number;
  key_prefix: string;
  url_template: string;
  is_alphanumeric: boolean;
}

interface FakeRepo {
  /** `undefined`: GitHub answers 404, which its documentation gives for "not enabled". */
  immutable?: { enabled: boolean; enforced_by_owner: boolean };
  autolinks?: AutolinkRecord[];
  /** The status a write gets back. */
  refuse?: number;
}

/** A fake GitHub answering the immutable-releases and autolinks reads, recording every write. */
function fakeApi(state: FakeRepo) {
  const writes: { method: string; path: string; body?: unknown }[] = [];
  const reads: string[] = [];
  const api: GitHubApi = {
    async request(method, path, body): Promise<ApiResponse> {
      if (method !== "GET") {
        if (state.refuse) return { status: state.refuse, data: { message: "Conflict" } };
        writes.push({ method, path, body });
        return { status: method === "POST" ? 201 : 204, data: null };
      }
      reads.push(path);
      if (path === "/repos/o/r") return { status: 200, data: {} };
      if (path === "/repos/o/r/immutable-releases") {
        return state.immutable
          ? { status: 200, data: state.immutable }
          : { status: 404, data: { message: "Not Found" } };
      }
      if (path === "/repos/o/r/autolinks") return { status: 200, data: state.autolinks ?? [] };
      return { status: 404, data: { message: "Not Found" } };
    },
  };
  return { api, writes, reads };
}

const apply = async (api: GitHubApi, changes: Awaited<ReturnType<typeof planGithub>>) => {
  for (const change of changes) await change.apply(api);
};
const rows = (changes: Awaited<ReturnType<typeof planGithub>>) => changes.map((c) => [c.setting, c.from, c.to]);

const link = (id: number, key_prefix: string, url_template: string, is_alphanumeric = true): AutolinkRecord => ({
  id,
  key_prefix,
  url_template,
  is_alphanumeric,
});

describe("github apply: immutable releases", () => {
  it("turns them on with PUT, whether GitHub reports off as 404 or as enabled: false", async () => {
    for (const immutable of [undefined, { enabled: false, enforced_by_owner: false }]) {
      const { api, writes } = fakeApi({ immutable });
      const changes = await planGithub(api, "o", "r", { security: { immutable_releases: true } });
      expect(rows(changes)).toEqual([["security.immutable_releases", "false", "true"]]);
      await apply(api, changes);
      expect(writes).toEqual([{ method: "PUT", path: "/repos/o/r/immutable-releases", body: undefined }]);
    }
  });

  it("turns them off with DELETE, and changes nothing when they are as asked", async () => {
    const on = { enabled: true, enforced_by_owner: false };
    const { api, writes } = fakeApi({ immutable: on });
    const changes = await planGithub(api, "o", "r", { security: { immutable_releases: false } });
    expect(rows(changes)).toEqual([["security.immutable_releases", "true", "false"]]);
    await apply(api, changes);
    expect(writes).toEqual([{ method: "DELETE", path: "/repos/o/r/immutable-releases", body: undefined }]);
    expect(
      await planGithub(fakeApi({ immutable: on }).api, "o", "r", { security: { immutable_releases: true } }),
    ).toEqual([]);
  });

  it("does not read them when the configuration leaves the key out", async () => {
    const { api, reads } = fakeApi({});
    expect(await planGithub(api, "o", "r", { security: {} })).toEqual([]);
    expect(reads).toEqual(["/repos/o/r"]);
  });

  it("explains a refusal, such as an owner that enforces them", async () => {
    const { api } = fakeApi({ immutable: { enabled: true, enforced_by_owner: true }, refuse: 409 });
    const [change] = await planGithub(api, "o", "r", { security: { immutable_releases: false } });
    await expect(change?.apply(api)).rejects.toThrow(
      /setting security\.immutable_releases failed: Conflict.*enforced by the owner/,
    );
  });
});

describe("github apply: autolinks", () => {
  it("adds the missing ones, recreates a changed one and removes the ones not listed", async () => {
    const { api, writes } = fakeApi({
      autolinks: [
        link(1, "TICKET-", "https://tickets.example.com/<num>"),
        link(2, "JIRA-", "https://old.example.com/browse/JIRA-<num>"),
        link(3, "OLD-", "https://old.example.com/<num>", false),
      ],
    });
    const changes = await planGithub(api, "o", "r", {
      autolinks: [
        { key_prefix: "TICKET-", url_template: "https://tickets.example.com/<num>" },
        { key_prefix: "JIRA-", url_template: "https://jira.example.com/browse/JIRA-<num>" },
        { key_prefix: "PR-", url_template: "https://example.com/pr/<num>", is_alphanumeric: false },
      ],
    });
    expect(rows(changes)).toEqual([
      ["autolinks.JIRA-", "https://old.example.com/browse/JIRA-<num>", "https://jira.example.com/browse/JIRA-<num>"],
      ["autolinks.PR-", "(none)", "https://example.com/pr/<num> (numbers only)"],
      ["autolinks.OLD-", "https://old.example.com/<num> (numbers only)", "(none)"],
    ]);
    await apply(api, changes);
    expect(writes).toEqual([
      { method: "DELETE", path: "/repos/o/r/autolinks/2", body: undefined },
      {
        method: "POST",
        path: "/repos/o/r/autolinks",
        body: {
          key_prefix: "JIRA-",
          url_template: "https://jira.example.com/browse/JIRA-<num>",
          is_alphanumeric: true,
        },
      },
      {
        method: "POST",
        path: "/repos/o/r/autolinks",
        body: { key_prefix: "PR-", url_template: "https://example.com/pr/<num>", is_alphanumeric: false },
      },
      { method: "DELETE", path: "/repos/o/r/autolinks/3", body: undefined },
    ]);
  });

  it("reads a left-out is_alphanumeric as GitHub's default, true", async () => {
    const { api } = fakeApi({ autolinks: [link(1, "TICKET-", "https://tickets.example.com/<num>", true)] });
    const same: Autolink[] = [{ key_prefix: "TICKET-", url_template: "https://tickets.example.com/<num>" }];
    expect(await planGithub(api, "o", "r", { autolinks: same })).toEqual([]);
    const numeric = same.map((l) => ({ ...l, is_alphanumeric: false }));
    expect(rows(await planGithub(api, "o", "r", { autolinks: numeric }))).toEqual([
      ["autolinks.TICKET-", "https://tickets.example.com/<num>", "https://tickets.example.com/<num> (numbers only)"],
    ]);
  });

  it("leaves autolinks alone when the key is left out, and removes every one for an empty list", async () => {
    const existing = { autolinks: [link(7, "TICKET-", "https://tickets.example.com/<num>")] };
    const untouched = fakeApi(existing);
    expect(await planGithub(untouched.api, "o", "r", {})).toEqual([]);
    expect(untouched.reads).toEqual(["/repos/o/r"]);
    const { api, writes } = fakeApi(existing);
    await apply(api, await planGithub(api, "o", "r", { autolinks: [] }));
    expect(writes).toEqual([{ method: "DELETE", path: "/repos/o/r/autolinks/7", body: undefined }]);
  });

  it("says what GitHub answered when a write is refused", async () => {
    const { api } = fakeApi({ refuse: 422 });
    const [change] = await planGithub(api, "o", "r", {
      autolinks: [{ key_prefix: "TICKET-", url_template: "https://tickets.example.com/<num>" }],
    });
    await expect(change?.apply(api)).rejects.toThrow(/adding autolink TICKET- failed: Conflict/);
  });
});

describe(".repokeeper.yml: immutable releases and autolinks", () => {
  const config = (lines: string[]) =>
    parseConfig(
      [
        "schema: 1",
        "standard: 1.0.0",
        "platform: github",
        "stacks: [node]",
        "modules: { health: false }",
        ...lines,
        "",
      ].join("\n"),
    );

  it("accepts both", () => {
    const parsed = config([
      "github:",
      "  security: { immutable_releases: true }",
      "  autolinks:",
      "    - { key_prefix: TICKET-, url_template: 'https://tickets.example.com/<num>' }",
      "    - { key_prefix: PR-, url_template: 'https://example.com/pr/<num>', is_alphanumeric: false }",
    ]);
    expect(parsed.github?.security).toEqual({ immutable_releases: true });
    expect(parsed.github?.autolinks).toHaveLength(2);
  });

  it("rejects a url_template without <num>, an unknown key and a repeated key_prefix", () => {
    expect(() =>
      config(["github:", "  autolinks: [{ key_prefix: TICKET-, url_template: 'https://tickets.example.com/' }]"]),
    ).toThrow(/url_template/);
    expect(() =>
      config(["github:", "  autolinks: [{ key_prefix: T-, url_template: 'https://e.com/<num>', alphanumeric: true }]"]),
    ).toThrow(/alphanumeric is not a known key/);
    expect(() =>
      config([
        "github:",
        "  autolinks:",
        "    - { key_prefix: T-, url_template: 'https://e.com/<num>' }",
        "    - { key_prefix: T-, url_template: 'https://f.com/<num>' }",
      ]),
    ).toThrow(/autolinks names the key_prefix "T-" twice/);
  });
});

describe("repokeeper github apply --dry-run: immutable releases and autolinks", () => {
  it("prints both the way it prints every other setting, and writes nothing", async () => {
    const dir = await tempDir();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd: dir });
    await writeFile(
      join(dir, ".repokeeper.yml"),
      [
        "schema: 1",
        "standard: 1.2.2",
        "platform: github",
        "stacks: [node]",
        "modules:",
        "  health: false",
        "github:",
        "  security:",
        "    immutable_releases: true",
        "  autolinks:",
        "    - key_prefix: TICKET-",
        "      url_template: https://tickets.example.com/<num>",
        "",
      ].join("\n"),
    );
    const { api, writes } = fakeApi({ immutable: { enabled: false, enforced_by_owner: false } });
    const c = capture(dir);
    const code = await run(["github", "apply", "--dry-run"], { ...c.io, githubApi: api });
    expect(code).toBe(0);
    expect(c.out).toEqual([
      "change     security.immutable_releases: false -> true",
      "change     autolinks.TICKET-: (none) -> https://tickets.example.com/<num>",
      "dry run: nothing applied",
    ]);
    expect(writes).toEqual([]);
  });
});
