import { describe, expect, it } from "vitest";
import type { ApiResponse, GitHubApi } from "../src/github/api.js";
import { GITHUB_ACTIONS_APP_ID } from "../src/github/checks.js";
import { planGithub, RULESET_NAME } from "../src/github/settings.js";

interface FakeRepo {
  repo?: Record<string, unknown>;
  topics?: string[];
  alerts?: boolean;
  fixes?: boolean;
  rulesets?: {
    id: number;
    name: string;
    enforcement: string;
    include: string[];
    exclude?: string[];
    rules: unknown[];
    bypass?: unknown[];
  }[];
  status?: number;
}

/** A fake GitHub that answers the reads `planGithub` makes and records every write. */
function fakeApi(state: FakeRepo) {
  const writes: { method: string; path: string; body?: unknown }[] = [];
  const api: GitHubApi = {
    async request(method, path, body): Promise<ApiResponse> {
      if (state.status) return { status: state.status, data: { message: "Resource not accessible by integration" } };
      if (method !== "GET") {
        writes.push({ method, path, body });
        return { status: 200, data: {} };
      }
      const rest = path.replace("/repos/o/r", "");
      if (rest === "") return { status: 200, data: state.repo ?? {} };
      if (rest === "/topics") return { status: 200, data: { names: state.topics ?? [] } };
      if (rest === "/vulnerability-alerts") return { status: state.alerts ? 204 : 404, data: null };
      if (rest === "/automated-security-fixes")
        return state.alerts ? { status: 200, data: { enabled: state.fixes ?? false } } : { status: 404, data: null };
      if (rest.startsWith("/rulesets?")) return { status: 200, data: state.rulesets ?? [] };
      const ruleset = state.rulesets?.find((r) => rest === `/rulesets/${r.id}`);
      if (ruleset) {
        return {
          status: 200,
          data: {
            enforcement: ruleset.enforcement,
            conditions: { ref_name: { include: ruleset.include, exclude: ruleset.exclude } },
            rules: ruleset.rules,
            ...(ruleset.bypass ? { bypass_actors: ruleset.bypass } : {}),
          },
        };
      }
      return { status: 404, data: { message: "Not Found" } };
    },
  };
  return { api, writes };
}

const apply = async (api: GitHubApi, changes: Awaited<ReturnType<typeof planGithub>>) => {
  for (const change of changes) await change.apply(api);
};

describe("github apply planning", () => {
  it("changes nothing for keys the config leaves out", async () => {
    const { api } = fakeApi({ repo: { allow_rebase_merge: true } });
    expect(await planGithub(api, "o", "r", { default_branch: "main" })).toEqual([]);
  });

  it("patches merge settings and the description, and replaces topics", async () => {
    const { api, writes } = fakeApi({
      repo: { allow_squash_merge: true, allow_rebase_merge: true, delete_branch_on_merge: false, description: "old" },
      topics: ["b", "a"],
    });
    const changes = await planGithub(api, "o", "r", {
      merge: { squash: true, rebase: false, delete_branch_on_merge: true },
      description: "new",
      topics: ["a", "cli"],
    });
    expect(changes.map((c) => [c.setting, c.from, c.to])).toEqual([
      ["merge.rebase", "true", "false"],
      ["merge.delete_branch_on_merge", "false", "true"],
      ["description", "old", "new"],
      ["topics", "a, b", "a, cli"],
    ]);
    await apply(api, changes);
    expect(writes).toEqual([
      { method: "PATCH", path: "/repos/o/r", body: { allow_rebase_merge: false } },
      { method: "PATCH", path: "/repos/o/r", body: { delete_branch_on_merge: true } },
      { method: "PATCH", path: "/repos/o/r", body: { description: "new" } },
      { method: "PUT", path: "/repos/o/r/topics", body: { names: ["a", "cli"] } },
    ]);
  });

  it("turns on Dependabot alerts before security updates", async () => {
    const { api, writes } = fakeApi({});
    const changes = await planGithub(api, "o", "r", {
      security: { dependabot_alerts: true, dependabot_security_updates: true },
    });
    await apply(api, changes);
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "PUT /repos/o/r/vulnerability-alerts",
      "PUT /repos/o/r/automated-security-fixes",
    ]);
  });

  it("creates the repokeeper ruleset on the default branch", async () => {
    const { api, writes } = fakeApi({});
    const changes = await planGithub(api, "o", "r", {
      protect: { required_checks: ["commits / commitlint"] },
    });
    expect(changes.map((c) => [c.setting, c.from, c.to])).toEqual([
      ["protect", "(none)", "pull request required (0 approvals); checks: commits / commitlint; no force push"],
    ]);
    await apply(api, changes);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "POST",
      path: "/repos/o/r/rulesets",
      body: {
        name: RULESET_NAME,
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      },
    });
    expect((writes[0]?.body as { rules: { type: string }[] } | undefined)?.rules.map((r) => r.type)).toEqual([
      "pull_request",
      "required_status_checks",
      "non_fast_forward",
    ]);
  });

  it("leaves a matching ruleset alone, updates a different one and deletes it when protect is false", async () => {
    const rules = [
      { type: "pull_request", parameters: { required_approving_review_count: 0 } },
      { type: "non_fast_forward" },
    ];
    const ruleset = { id: 7, name: RULESET_NAME, enforcement: "active", include: ["~DEFAULT_BRANCH"], rules };
    expect(await planGithub(fakeApi({ rulesets: [ruleset] }).api, "o", "r", { protect: {} })).toEqual([]);

    const updated = fakeApi({ rulesets: [ruleset] });
    await apply(updated.api, await planGithub(updated.api, "o", "r", { protect: { required_approvals: 1 } }));
    expect(updated.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PUT /repos/o/r/rulesets/7"]);

    const removed = fakeApi({ rulesets: [ruleset] });
    await apply(removed.api, await planGithub(removed.api, "o", "r", { protect: false }));
    expect(removed.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["DELETE /repos/o/r/rulesets/7"]);
  });

  it("requires checks by app, covers named branches and keeps what it does not manage", async () => {
    const bypass = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
    const ruleset = {
      id: 7,
      name: RULESET_NAME,
      enforcement: "active",
      include: ["~DEFAULT_BRANCH"],
      exclude: ["refs/heads/tmp"],
      rules: [
        { type: "pull_request", parameters: { required_approving_review_count: 0, allowed_merge_methods: ["squash"] } },
        { type: "required_linear_history" },
        { type: "non_fast_forward" },
      ],
      bypass,
    };
    const { api, writes } = fakeApi({ rulesets: [ruleset] });
    const changes = await planGithub(api, "o", "r", {
      protect: {
        required_checks: ["CI result", { context: "Sonar", integration_id: null }],
        require_up_to_date: true,
        branches: ["main", "develop"],
      },
    });
    expect(changes.map((c) => [c.from, c.to])).toEqual([
      [
        "pull request required (0 approvals); no required checks; no force push",
        "pull request required (0 approvals); checks: CI result, Sonar (any app) (branch up to date); no force push; " +
          "on main, develop",
      ],
    ]);
    await apply(api, changes);
    const body = writes[0]?.body as { conditions: unknown; rules: unknown[]; bypass_actors: unknown };
    expect(writes[0]?.method).toBe("PUT");
    expect(body.conditions).toEqual({
      ref_name: { include: ["refs/heads/main", "refs/heads/develop"], exclude: ["refs/heads/tmp"] },
    });
    expect(body.bypass_actors).toEqual(bypass);
    expect(body.rules).toEqual([
      {
        type: "pull_request",
        parameters: {
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["squash"],
          required_approving_review_count: 0,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [
            { context: "CI result", integration_id: GITHUB_ACTIONS_APP_ID },
            { context: "Sonar" },
          ],
        },
      },
      { type: "non_fast_forward" },
      { type: "required_linear_history" },
    ]);

    // what it wrote is what the config asks for
    const written = { ...ruleset, include: ["refs/heads/develop", "refs/heads/main"], rules: body.rules };
    const again = await planGithub(fakeApi({ rulesets: [written] }).api, "o", "r", {
      protect: {
        required_checks: ["CI result", { context: "Sonar", integration_id: null }],
        require_up_to_date: true,
        branches: ["main", "develop"],
      },
    });
    expect(again).toEqual([]);
  });

  it("leaves out a required check that no workflow job reports, with a warning", async () => {
    const workflow = [
      "on: [push, pull_request]",
      "jobs:",
      "  result:",
      "    name: CI result",
      "    runs-on: ubuntu-latest",
      "",
    ].join("\n");
    const warnings: string[] = [];
    const protect = { required_checks: ["CI result", "gone"] };
    const changes = await planGithub(
      fakeApi({}).api,
      "o",
      "r",
      { protect },
      { workflows: [workflow], warn: (m) => warnings.push(m) },
    );
    expect(changes.map((c) => c.to)).toEqual(["pull request required (0 approvals); checks: CI result; no force push"]);
    expect(warnings).toEqual([
      'protect.required_checks: no workflow job reports "gone"; left out, since every pull request would wait for it',
    ]);

    // with no workflow files nothing is required, rather than a check that never comes
    const none = await planGithub(fakeApi({}).api, "o", "r", { protect }, { workflows: [] });
    expect(none.map((c) => c.to)).toEqual(["pull request required (0 approvals); no required checks; no force push"]);
  });

  it("names the missing access when GitHub refuses", async () => {
    const { api } = fakeApi({ status: 403 });
    await expect(planGithub(api, "o", "r", { topics: [] })).rejects.toThrow(
      "reading o/r failed: Resource not accessible by integration; this needs admin access to o/r",
    );
  });
});
