import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import type { ApiResponse, GitHubApi } from "../src/github/api.js";
import { readLockfile, sbomPackages, stalePackages, type VersionIndex } from "../src/github/lockfiles.js";
import { isReleasable } from "../src/github/status.js";
import { STANDARD_VERSION } from "../src/version.js";
import { capture } from "./helpers.js";

type Routes = Record<string, ApiResponse | ((query: string) => ApiResponse)>;

const ok = (data: unknown): ApiResponse => ({ status: 200, data });
const blob = (text: string) => ok({ content: Buffer.from(text).toString("base64"), encoding: "base64" });
const purl = (locator: string) => ({ externalRefs: [{ referenceType: "purl", referenceLocator: locator }] });
const sbom = (...locators: string[]) => ok({ sbom: { packages: locators.map(purl) } });

const PACKAGE_LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": { name: "app" },
    "node_modules/vite": { version: "7.3.9" },
    "node_modules/@scope/lib": { version: "1.0.0" },
    "node_modules/other/node_modules/vite": { version: "6.0.0" },
  },
});

/** A clean repository `a`: no pull requests, alerts, failures or lockfiles; released at v1.0.0. */
function cleanRepo(name: string): Routes {
  const base = `/repos/me/${name}`;
  return {
    [`${base}/pulls`]: ok([]),
    [`${base}/dependabot/alerts`]: ok([]),
    [`${base}/actions/workflows`]: ok({ workflows: [{ path: ".github/workflows/ci.yml", state: "active" }] }),
    [`${base}/actions/runs`]: ok({
      workflow_runs: [{ name: "CI", path: ".github/workflows/ci.yml", event: "push", conclusion: "success" }],
    }),
    [`${base}/releases/latest`]: ok({ tag_name: "v1.0.0" }),
    [`${base}/compare/v1.0.0...main`]: ok({ ahead_by: 0, commits: [] }),
    [`${base}/git/trees/main`]: ok({ tree: [{ path: "README.md", type: "blob", sha: "r" }] }),
  };
}

function fakeApi(routes: Routes, repos: unknown[]): { api: GitHubApi; calls: string[] } {
  const calls: string[] = [];
  const api: GitHubApi = {
    async request(method, path) {
      calls.push(`${method} ${path}`);
      const [route = "", query = ""] = path.split("?");
      if (route === "/user") return ok({ login: "me" });
      if (route === "/user/repos") return ok(query.includes("page=1") ? repos : []);
      const answer = routes[route];
      if (answer === undefined) return { status: 404, data: { message: "Not Found" } };
      return typeof answer === "function" ? answer(query) : answer;
    },
  };
  return { api, calls };
}

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  default_branch: "main",
  owner: { login: "me" },
  ...extra,
});

async function status(routes: Routes, repos: unknown[], args: string[] = []) {
  const { api, calls } = fakeApi(routes, repos);
  const c = capture();
  const code = await run(["github", "status", ...args], { ...c.io, githubApi: api });
  return { code, out: c.out.join("\n"), err: c.err.join("\n"), calls };
}

describe("repokeeper github status", () => {
  it("prints only a count when every repository is clean, and skips archived repositories and forks", async () => {
    const result = await status({ ...cleanRepo("a") }, [
      repo("a"),
      repo("old", { archived: true }),
      repo("copy", { fork: true }),
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toBe("all 1 repositories clean");
    expect(result.calls.some((call) => call.includes("/repos/me/old"))).toBe(false);
    expect(result.calls.some((call) => call.includes("/repos/me/copy"))).toBe(false);
  });

  it("includes forks with --forks and lists every repository with --all", async () => {
    const result = await status(
      { ...cleanRepo("a"), ...cleanRepo("copy") },
      [repo("a"), repo("copy", { fork: true })],
      ["--forks", "--all"],
    );
    expect(result.out).toMatch(/^repo\s+prs\s+alerts\s+ci\s+unreleased\s+graph\s+standard$/m);
    expect(result.out).toMatch(/^copy\s+0\s+0\s+ok\s+0 since v1\.0\.0\s+-\s+-$/m);
    expect(result.out).toContain("all 2 repositories clean");
  });

  it("shows the standard each repository is on and flags one behind this repokeeper's", async () => {
    const config = (standard: string) =>
      ok({ content: Buffer.from(`standard: "${standard}"\nstacks: [node]\n`).toString("base64"), encoding: "base64" });
    const routes: Routes = {
      ...cleanRepo("a"),
      ...cleanRepo("b"),
      ...cleanRepo("c"),
      ...cleanRepo("d"),
      "/repos/me/a/contents/.repokeeper.yml": config(STANDARD_VERSION),
      "/repos/me/b/contents/.repokeeper.yml": config("1.0.0"),
      "/repos/me/d/contents/.repokeeper.yml": config("99.0.0"),
    };
    const result = await status(routes, [repo("a"), repo("b"), repo("c"), repo("d")], ["--all"]);
    expect(result.out).toMatch(/^repo\s+prs\s+alerts\s+ci\s+unreleased\s+graph\s+standard$/m);
    expect(result.out).toMatch(new RegExp(`^a\\s.*\\s-\\s+${STANDARD_VERSION.replaceAll(".", "\\.")}$`, "m"));
    expect(result.out).toMatch(
      new RegExp(`^b\\s.*\\s1\\.0\\.0 \\(${STANDARD_VERSION.replaceAll(".", "\\.")} out\\)$`, "m"),
    );
    expect(result.out).toMatch(/^c\s.*\s-\s+-$/m);
    expect(result.out).toMatch(/^d\s.*\s99\.0\.0 \(newer than this repokeeper\)$/m);
    expect(result.out).toContain("3 of 4 repositories clean, 1 need attention");
    expect(result.out).toContain("standard behind: b (run `repokeeper update` there)");

    const json = JSON.parse((await status(routes, [repo("b")], ["--json"])).out);
    expect(json.repositories[0].standard).toEqual({ state: "behind", version: "1.0.0", current: STANDARD_VERSION });
    expect(json.repositories[0].attention).toEqual(["standard behind"]);
  });

  it("reports pull requests with their checks, alerts by severity and failing workflows", async () => {
    const base = "/repos/me/a";
    const result = await status(
      {
        ...cleanRepo("a"),
        [`${base}/pulls`]: ok([
          { number: 7, title: "chore(deps): bump vite", user: { login: "dependabot[bot]" }, head: { sha: "s1" } },
        ]),
        [`${base}/commits/s1/check-runs`]: ok({
          total_count: 2,
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "failure" },
          ],
        }),
        [`${base}/dependabot/alerts`]: ok([
          { security_advisory: { severity: "low" } },
          { security_advisory: { severity: "critical" } },
          { security_advisory: { severity: "low" } },
        ]),
        [`${base}/actions/workflows`]: ok({
          workflows: [
            { path: ".github/workflows/ci.yml", state: "active" },
            { path: ".github/workflows/codeql.yml", state: "active" },
          ],
        }),
        [`${base}/actions/runs`]: ok({
          workflow_runs: [
            {
              name: "Dependabot Updates",
              path: "dynamic/dependabot/dependabot-updates",
              event: "dynamic",
              conclusion: "failure",
            },
            { name: "CI", path: ".github/workflows/ci.yml", event: "push", conclusion: "cancelled" },
            {
              name: "CI",
              path: ".github/workflows/ci.yml",
              event: "push",
              conclusion: "failure",
              created_at: "2026-10-01T00:00:00Z",
              html_url: "https://x/1",
            },
            { name: "codeql", path: ".github/workflows/codeql.yml", event: "schedule", conclusion: "success" },
            { name: "CI", path: ".github/workflows/ci.yml", event: "push", conclusion: "success" },
          ],
        }),
      },
      [repo("a")],
      ["--exit-code"],
    );
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^a\s+1\s+1 critical, 2 low\s+failed\s+0 since v1\.0\.0\s+-\s+-$/m);
    expect(result.out).toContain("  a#7  dependabot[bot]  checks failure  chore(deps): bump vite");
    expect(result.out).toContain("  a: CI failure on 2026-10-01 https://x/1");
    expect(result.out).toContain("0 of 1 repositories clean, 1 need attention");
  });

  it("says off when Dependabot alerts are disabled and none when no workflow ran", async () => {
    const base = "/repos/me/a";
    const result = await status(
      {
        ...cleanRepo("a"),
        [`${base}/dependabot/alerts`]: {
          status: 403,
          data: { message: "Dependabot alerts are disabled for this repository." },
        },
        [`${base}/actions/runs`]: ok({
          workflow_runs: [
            { name: "pages", path: "dynamic/pages/pages-build-deployment", event: "dynamic", conclusion: "success" },
          ],
        }),
      },
      [repo("a")],
      ["--all"],
    );
    expect(result.out).toMatch(/^a\s+0\s+off\s+none\s+0 since v1\.0\.0\s+-\s+-$/m);
    expect(result.out).not.toContain("running");
  });

  it("counts commits since the latest tag and flags only releasable ones; no tags otherwise", async () => {
    const commits = (...messages: string[]) => messages.map((message) => ({ commit: { message } }));
    const chores = await status(
      {
        ...cleanRepo("a"),
        "/repos/me/a/compare/v1.0.0...main": ok({ ahead_by: 2, commits: commits("chore(deps): bump x", "docs: y") }),
      },
      [repo("a")],
      ["--all"],
    );
    expect(chores.out).toContain("2 since v1.0.0");
    expect(chores.out).toContain("all 1 repositories clean");

    const routes: Routes = { ...cleanRepo("a") };
    delete routes["/repos/me/a/releases/latest"];
    routes["/repos/me/a/tags"] = ok([{ name: "v1.9.0" }, { name: "v1.10.0" }, { name: "nightly" }]);
    routes["/repos/me/a/compare/v1.10.0...main"] = ok({ ahead_by: 1, commits: commits("feat: z") });
    const tagged = await status(routes, [repo("a")]);
    expect(tagged.out).toContain("1 since v1.10.0 (1 feat/fix)");

    routes["/repos/me/a/tags"] = ok([]);
    expect((await status(routes, [repo("a")], ["--all"])).out).toContain("no tags");
  });

  it("finds a dependency graph that still names versions the lockfiles no longer contain", async () => {
    const base = "/repos/me/a";
    const result = await status(
      {
        ...cleanRepo("a"),
        [`${base}/git/trees/main`]: ok({
          tree: [
            { path: "package-lock.json", type: "blob", sha: "lock" },
            { path: "web/packages.config", type: "blob", sha: "cfg" },
            { path: "node_modules/x/package-lock.json", type: "blob", sha: "ignored" },
          ],
        }),
        [`${base}/git/blobs/lock`]: blob(PACKAGE_LOCK),
        [`${base}/git/blobs/cfg`]: blob(
          '<packages>\n  <package id="bootstrap" version="3.4.1" targetFramework="net45" />\n</packages>',
        ),
        [`${base}/dependency-graph/sbom`]: sbom(
          "pkg:npm/vite@7.3.6",
          "pkg:npm/vite@6.0.0",
          "pkg:npm/zod@%5E3.25.76",
          "pkg:npm/%40scope/lib@1.0.0",
          "pkg:npm/gone@1.0.0",
          "pkg:nuget/Bootstrap@3.0.0",
          "pkg:githubactions/actions/checkout@4",
        ),
      },
      [repo("a")],
      ["--exit-code"],
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain("stale (2)");
    expect(result.out).toContain("a commit touching the manifest makes GitHub re-read it");
    expect(result.out).toContain("  a: npm vite 7.3.6 in the graph, 6.0.0, 7.3.9 in package-lock.json");
    expect(result.out).toContain("  a: nuget Bootstrap 3.0.0 in the graph, 3.4.1 in web/packages.config");
    expect(result.calls).not.toContain("GET /repos/me/a/git/blobs/ignored");
  });

  it("keeps going when one repository fails, and reports it", async () => {
    const result = await status(
      {
        ...cleanRepo("a"),
        ...cleanRepo("b"),
        "/repos/me/b/pulls": { status: 500, data: { message: "Server Error" } },
        "/repos/me/b/dependabot/alerts": { status: 403, data: { message: "API rate limit exceeded for user" } },
      },
      [repo("a"), repo("b")],
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain("  b: pulls: HTTP 500: Server Error");
    expect(result.out).toContain("  b: alerts: rate limited");
    expect(result.out).toContain("rate limit was reached");
    expect(result.out).toContain("1 of 2 repositories clean, 1 need attention");
  });

  it("prints JSON with every repository and follows the Link header of the alerts", async () => {
    const page2 = [{ security_advisory: { severity: "high" } }];
    const routes: Routes = {
      ...cleanRepo("a"),
      "/repos/me/a/dependabot/alerts": (query) =>
        query.includes("after=c1")
          ? ok(page2)
          : {
              status: 200,
              data: [{ security_advisory: { severity: "high" } }],
              link: '<https://api.github.com/repos/me/a/dependabot/alerts?per_page=100&after=c1>; rel="next"',
            },
    };
    const result = await status(routes, [repo("a")], ["--json"]);
    const report = JSON.parse(result.out);
    expect(report.owner).toBe("me");
    expect(report.clean).toBe(0);
    expect(report.repositories[0].alerts).toEqual({ state: "on", total: 2, bySeverity: { high: 2 } });
    expect(report.repositories[0].attention).toEqual(["dependabot alerts"]);
  });

  it("reads another owner's public repositories, and refuses its options on other commands", async () => {
    const { api, calls } = fakeApi(cleanRepo("a"), []);
    const users: GitHubApi = {
      async request(method, path) {
        if (path.startsWith("/users/other/repos")) return ok([repo("a", { owner: { login: "other" } })]);
        return api.request(method, path.replace("/repos/other/", "/repos/me/"));
      },
    };
    const c = capture();
    expect(await run(["github", "status", "--owner", "other"], { ...c.io, githubApi: users })).toBe(0);
    expect(c.out).toEqual(["all 1 repositories clean"]);
    expect(calls).toContain("GET /orgs/other/repos?type=all&per_page=100&page=1");
    expect(await run(["check", "--owner", "x"], capture().io)).toBe(2);
    expect(await run(["github", "apply", "--exit-code"], capture().io)).toBe(2);
  });
});

describe("lockfiles and the dependency graph", () => {
  it("reads every pnpm lockfile format, including pnpm 11's two documents", () => {
    const index: VersionIndex = new Map();
    readLockfile(
      "pnpm-lock.yaml",
      "lockfileVersion: 5.4\npackages:\n  /@s/a/1.0.0_react@18.0.0:\n    dev: false\n",
      index,
    );
    readLockfile(
      "v6/pnpm-lock.yaml",
      "lockfileVersion: '6.0'\npackages:\n  /b@2.0.0(react@18.0.0):\n    dev: false\n",
      index,
    );
    readLockfile(
      "v9/pnpm-lock.yaml",
      "---\nlockfileVersion: '9.0'\nimporters: {}\n---\nlockfileVersion: '9.0'\npackages:\n  '@s/c@3.0.0':\n    resolution: {}\n",
      index,
    );
    expect(index).toEqual(
      new Map([
        ["npm:@s/a", new Set(["1.0.0"])],
        ["npm:b", new Set(["2.0.0"])],
        ["npm:@s/c", new Set(["3.0.0"])],
      ]),
    );
  });

  it("reads package-lock v1 and treats NuGet versions and ids loosely", () => {
    const index: VersionIndex = new Map();
    readLockfile(
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } } },
      }),
      index,
    );
    readLockfile("packages.config", '<package version="1.17.0.0" id="PagedList" />', index);
    const graph = sbomPackages({
      sbom: { packages: [purl("pkg:npm/b@2.0.0"), purl("pkg:nuget/pagedlist@1.17.0"), purl("pkg:npm/a@1.x")] },
    });
    expect(graph).toHaveLength(2);
    expect(stalePackages(graph, index)).toEqual([]);
  });

  it("tells release-please's releasable commits from the rest", () => {
    expect(isReleasable("fix(deps): bump x")).toBe(true);
    expect(isReleasable("refactor!: drop y")).toBe(true);
    expect(isReleasable("chore: z\n\nBREAKING CHANGE: gone")).toBe(true);
    expect(isReleasable("chore(main): release 1.0.0")).toBe(false);
    expect(isReleasable("Merge pull request #1 from x/y")).toBe(false);
  });
});
