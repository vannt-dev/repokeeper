import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { parseConfig } from "../src/config/load.js";
import type { GitLabApi } from "../src/gitlab/api.js";
import { capture, tempDir } from "./helpers.js";

const HEAD = "schema: 1\nstandard: 1.4.3\nplatform: gitlab\nstacks: [node]\nmodules:\n  health: false\n";
const SETTINGS = [
  "gitlab:",
  "  description: A demo",
  "  topics: [cli, demo]",
  "  merge:",
  "    method: ff",
  "    squash: default_on",
  "    delete_source_branch: true",
  "    pipeline_must_succeed: true",
  "  protect:",
  "    merge: developers",
  '  renovate_schedule: "0 5 * * 1"',
  "",
].join("\n");

/** A project in a subgroup, as GitLab allows: its path has two slashes. */
const PROJECT = "/projects/acme%2Ftools%2Fdemo";

async function repo(config = HEAD + SETTINGS, remote = "https://gitlab.com/acme/tools/demo.git"): Promise<string> {
  const dir = await tempDir();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  await writeFile(join(dir, ".repokeeper.yml"), config);
  return dir;
}

interface State {
  project: Record<string, unknown>;
  protection: Record<string, unknown> | null;
  schedules: Array<Record<string, unknown>>;
  variables: string[];
  /** Status every request is answered with instead, to play a token without access. */
  refuse?: number;
}

const fresh = (): State => ({
  project: {
    default_branch: "main",
    description: null,
    topics: [],
    merge_method: "merge",
    squash_option: "default_off",
    remove_source_branch_after_merge: true,
    only_allow_merge_if_pipeline_succeeds: false,
  },
  protection: null,
  schedules: [{ id: 7, description: "nightly build", ref: "refs/heads/main", cron: "0 1 * * *", active: true }],
  variables: [],
});

/** What a project already set up as SETTINGS asks looks like. */
const settled = (): State => ({
  project: {
    default_branch: "main",
    description: "A demo",
    topics: ["demo", "cli"],
    merge_method: "ff",
    squash_option: "default_on",
    remove_source_branch_after_merge: true,
    only_allow_merge_if_pipeline_succeeds: true,
  },
  protection: {
    name: "main",
    push_access_levels: [{ access_level: 40 }],
    merge_access_levels: [{ access_level: 30 }],
    allow_force_push: false,
  },
  schedules: [{ id: 9, description: "repokeeper: renovate", ref: "refs/heads/main", cron: "0 5 * * 1", active: true }],
  variables: ["GITLAB_TOKEN", "RENOVATE_TOKEN"],
});

function fakeApi(state: State) {
  const writes: Array<[string, unknown?]> = [];
  const api: GitLabApi = {
    async request(method, path, body) {
      if (state.refuse) return { status: state.refuse, data: { message: `${state.refuse} Forbidden` } };
      if (!path.startsWith(PROJECT)) return { status: 404, data: { message: "404 Project Not Found" } };
      const rest = path.slice(PROJECT.length);
      if (method !== "GET") {
        writes.push(body === undefined ? [`${method} ${rest}`] : [`${method} ${rest}`, body]);
        return { status: method === "DELETE" ? 204 : 200, data: {} };
      }
      if (rest === "") return { status: 200, data: state.project };
      if (rest === "/protected_branches/main" && state.protection) return { status: 200, data: state.protection };
      if (rest === "/pipeline_schedules") return { status: 200, data: state.schedules };
      const variable = rest.match(/^\/variables\/(.+)$/)?.[1];
      if (variable && state.variables.includes(variable)) return { status: 200, data: { key: variable } };
      return { status: 404, data: { message: "404 Not Found" } };
    },
  };
  return { api, writes };
}

async function gitlabApply(dir: string, args: string[], state: State = fresh(), confirm?: boolean) {
  const { api, writes } = fakeApi(state);
  const c = capture(dir);
  const io = { ...c.io, gitlabApi: api, ...(confirm === undefined ? {} : { confirm: async () => confirm }) };
  const code = await run(["gitlab", "apply", ...args], io);
  return { code, out: c.out.join("\n"), err: c.err.join("\n"), writes };
}

describe("repokeeper gitlab apply", () => {
  it("previews the changes on a dry run and names the secrets nobody has set", async () => {
    const result = await gitlabApply(await repo(), ["--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out.split("\n")).toEqual([
      "change     merge.method: merge -> ff",
      "change     merge.squash: default_off -> default_on",
      "change     merge.pipeline_must_succeed: false -> true",
      "change     description: (none) -> A demo",
      "change     topics: (none) -> cli, demo",
      "change     protect main: (not protected) -> push: maintainers; merge: developers; no force push",
      "change     renovate_schedule: (none) -> 0 5 * * 1 on main",
      "note: no CI/CD variable GITLAB_TOKEN in acme/tools/demo: the release job stays inactive until one is set, here or in a group above",
      "note: no CI/CD variable RENOVATE_TOKEN in acme/tools/demo: the renovate job stays inactive until one is set, here or in a group above",
      "dry run: nothing applied",
    ]);
    expect(result.writes).toEqual([]);
  });

  it("applies nothing without --yes when nobody can confirm, or when the answer is no", async () => {
    const silent = await gitlabApply(await repo(), []);
    expect(silent.code).toBe(1);
    expect(silent.out).toContain("nothing applied; pass --yes to apply");
    expect(silent.writes).toEqual([]);
    expect((await gitlabApply(await repo(), [], fresh(), false)).writes).toEqual([]);
  });

  it("applies with --yes or after confirmation, and never writes a variable", async () => {
    const yes = await gitlabApply(await repo(), ["--yes"]);
    expect(yes.code).toBe(0);
    expect(yes.out).toContain("applied    protect main");
    expect(yes.writes).toEqual([
      ["PUT ", { merge_method: "ff" }],
      ["PUT ", { squash_option: "default_on" }],
      ["PUT ", { only_allow_merge_if_pipeline_succeeds: true }],
      ["PUT ", { description: "A demo" }],
      ["PUT ", { topics: ["cli", "demo"] }],
      [
        "POST /protected_branches",
        { name: "main", push_access_level: 40, merge_access_level: 30, allow_force_push: false },
      ],
      [
        "POST /pipeline_schedules",
        { description: "repokeeper: renovate", cron_timezone: "UTC", cron: "0 5 * * 1", ref: "main", active: true },
      ],
    ]);
    expect((await gitlabApply(await repo(), [], fresh(), true)).writes).toHaveLength(7);
  });

  it("says so when the project already matches, whatever order its topics are in", async () => {
    const result = await gitlabApply(await repo(), [], settled());
    expect(result.code).toBe(0);
    expect(result.out).toBe("GitLab settings of acme/tools/demo match .repokeeper.yml");
    expect(result.writes).toEqual([]);
  });

  it("replaces a protection that differs, and moves its own schedule only", async () => {
    const state = settled();
    state.protection = {
      name: "main",
      push_access_levels: [{ access_level: 40 }, { access_level: 30 }],
      merge_access_levels: [{ access_level: 40 }],
      allow_force_push: true,
    };
    state.schedules = [
      { id: 7, description: "nightly build", ref: "main", cron: "0 1 * * *", active: true },
      { id: 9, description: "repokeeper: renovate", ref: "main", cron: "0 3 * * *", active: false },
    ];
    const result = await gitlabApply(await repo(), ["--yes"], state);
    expect(result.out).toContain(
      "change     protect main: push: developers + maintainers; merge: maintainers; force push allowed -> push: maintainers; merge: developers; no force push",
    );
    expect(result.out).toContain("change     renovate_schedule: 0 3 * * * on main (inactive) -> 0 5 * * 1 on main");
    expect(result.writes).toEqual([
      ["DELETE /protected_branches/main"],
      [
        "POST /protected_branches",
        { name: "main", push_access_level: 40, merge_access_level: 30, allow_force_push: false },
      ],
      ["PUT /pipeline_schedules/9", { cron: "0 5 * * 1", ref: "main", active: true }],
    ]);
  });

  it("removes the protection and the schedule when the file says false, and leaves absent ones alone", async () => {
    const off = `${HEAD}gitlab:\n  protect: false\n  renovate_schedule: false\n`;
    const removed = await gitlabApply(await repo(off), ["--yes"], settled());
    expect(removed.writes).toEqual([["DELETE /protected_branches/main"], ["DELETE /pipeline_schedules/9"]]);
    const nothing = await gitlabApply(await repo(off), ["--yes"], {
      ...fresh(),
      variables: ["GITLAB_TOKEN", "RENOVATE_TOKEN"],
    });
    expect(nothing.out).toBe("GitLab settings of acme/tools/demo match .repokeeper.yml");
  });

  it("protects the branch the file names, and asks about no secret of a module that is off", async () => {
    const config = `${HEAD.replace("health: false", "health: false\n  release: false\n  deps: false")}gitlab:\n  default_branch: trunk\n  protect: {}\n`;
    const result = await gitlabApply(await repo(config), ["--yes"]);
    expect(result.out).not.toContain("note:");
    expect(result.writes).toEqual([
      [
        "POST /protected_branches",
        { name: "trunk", push_access_level: 40, merge_access_level: 40, allow_force_push: false },
      ],
    ]);
  });

  it("stops with what the token lacks when GitLab refuses", async () => {
    const result = await gitlabApply(await repo(), ["--dry-run"], { ...fresh(), refuse: 403 });
    expect(result.code).toBe(3);
    expect(result.err).toContain(
      "reading acme/tools/demo failed: 403 Forbidden; this needs the Maintainer role on acme/tools/demo and a token with the api scope",
    );
  });

  it("reports variables it may not read instead of calling them missing", async () => {
    const { api } = fakeApi(settled());
    const guarded: GitLabApi = {
      request: (method, path, body) =>
        path.includes("/variables/")
          ? Promise.resolve({ status: 403, data: { message: "403 Forbidden" } })
          : api.request(method, path, body),
    };
    const c = capture(await repo());
    expect(await run(["gitlab", "apply"], { ...c.io, gitlabApi: guarded })).toBe(0);
    expect(c.out.join("\n")).toContain(
      "note: could not read the CI/CD variables of acme/tools/demo (HTTP 403); GITLAB_TOKEN was not checked",
    );
  });

  it("is for GitLab projects only and has no other subcommand", async () => {
    const github = await repo(HEAD.replace("platform: gitlab", "platform: github"), "https://github.com/o/r.git");
    const wrong = await gitlabApply(github, []);
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain("this repository uses the github platform");
    expect(await run(["gitlab", "sync"], capture().io)).toBe(2);
  });

  it("refuses settings GitLab has no such value for", () => {
    const bad = (settings: string) => () => parseConfig(`${HEAD}gitlab:\n${settings}`);
    expect(bad("  protect:\n    push: owners\n")).toThrow("gitlab.protect");
    expect(bad("  merge:\n    method: squash\n")).toThrow(
      "gitlab.merge.method must be one of: merge, rebase_merge, ff",
    );
    expect(bad("  renovate_schedule: weekly\n")).toThrow("gitlab.renovate_schedule");
    expect(bad("  protect:\n    required_approvals: 1\n")).toThrow("gitlab.protect");
  });
});
