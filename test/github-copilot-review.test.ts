import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { parseConfig } from "../src/config/load.js";
import type { ApiResponse, GitHubApi } from "../src/github/api.js";
import { planGithub, RULESET_NAME } from "../src/github/settings.js";
import { capture, tempDir } from "./helpers.js";

interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}

interface FakeRepo {
  /** The repokeeper ruleset, if the repository has one; a write replaces its rules. */
  rules?: Rule[];
  /**
   * GitHub refuses a ruleset write holding a copilot_code_review rule, as without Copilot;
   * `on-push` refuses only one that reviews each push.
   */
  noCopilot?: boolean | "on-push";
  /** The status every write gets back. */
  refuse?: number;
}

const COPILOT = "copilot_code_review";

/** A fake GitHub holding one ruleset, refusing the Copilot rule when told to, recording every write. */
function fakeApi(state: FakeRepo) {
  const writes: { method: string; path: string; body?: { rules: Rule[] } }[] = [];
  /** Every write sent, refused ones included. */
  const attempts: string[] = [];
  const api: GitHubApi = {
    async request(method, path, body): Promise<ApiResponse> {
      const rest = path.replace("/repos/o/r", "");
      if (method !== "GET") {
        const rules = (body as { rules?: Rule[] } | undefined)?.rules ?? [];
        attempts.push(`${method} ${path}`);
        if (state.refuse) return { status: state.refuse, data: { message: "Forbidden" } };
        const refused = (r: Rule) =>
          r.type === COPILOT && (state.noCopilot === true || r.parameters?.review_on_push === true);
        if (state.noCopilot && rules.some(refused)) {
          return { status: 422, data: { message: "Validation Failed" } };
        }
        writes.push({ method, path, body: body as { rules: Rule[] } });
        state.rules = rules;
        return { status: method === "POST" ? 201 : 200, data: {} };
      }
      if (rest === "") return { status: 200, data: {} };
      if (rest.startsWith("/rulesets?")) {
        return { status: 200, data: state.rules ? [{ id: 7, name: RULESET_NAME }] : [] };
      }
      if (rest === "/rulesets/7" && state.rules) {
        return {
          status: 200,
          data: {
            enforcement: "active",
            conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
            rules: state.rules,
          },
        };
      }
      return { status: 404, data: { message: "Not Found" } };
    },
  };
  return { api, writes, attempts };
}

const apply = async (api: GitHubApi, changes: Awaited<ReturnType<typeof planGithub>>) => {
  for (const change of changes) await change.apply(api);
};
const rows = (changes: Awaited<ReturnType<typeof planGithub>>) => changes.map((c) => [c.setting, c.from, c.to]);
const copilotRule = (rules: Rule[] | undefined) => rules?.find((r) => r.type === COPILOT);

const BASE = "pull request required (0 approvals); no required checks; no force push";
const plain: Rule[] = [
  { type: "pull_request", parameters: { required_approving_review_count: 0 } },
  { type: "non_fast_forward" },
];

describe("github apply: Copilot code review rule", () => {
  it("is off by default: a new ruleset has no Copilot rule", async () => {
    const { api, writes } = fakeApi({});
    const changes = await planGithub(api, "o", "r", { protect: {} });
    expect(rows(changes)).toEqual([["protect", "(none)", BASE]]);
    await apply(api, changes);
    expect(copilotRule(writes[0]?.body?.rules)).toBeUndefined();
  });

  it("keeps a Copilot rule added by hand while the key is left out", async () => {
    const byHand = { type: COPILOT, parameters: { review_on_push: true, review_draft_pull_requests: false } };
    expect(await planGithub(fakeApi({ rules: [...plain, byHand] }).api, "o", "r", { protect: {} })).toEqual([]);
    const { api, writes } = fakeApi({ rules: [...plain, byHand] });
    await apply(api, await planGithub(api, "o", "r", { protect: { required_approvals: 1 } }));
    expect(copilotRule(writes[0]?.body?.rules)).toEqual(byHand);
  });

  it("adds the rule with true, both options off, and then finds nothing to change", async () => {
    const state: FakeRepo = { rules: plain };
    const { api, writes } = fakeApi(state);
    const changes = await planGithub(api, "o", "r", { protect: { copilot_review: true } });
    expect(rows(changes)).toEqual([["protect", BASE, `${BASE}; Copilot review`]]);
    await apply(api, changes);
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PUT /repos/o/r/rulesets/7"]);
    expect(copilotRule(writes[0]?.body?.rules)).toEqual({
      type: COPILOT,
      parameters: { review_on_push: false, review_draft_pull_requests: false },
    });
    expect(await planGithub(fakeApi(state).api, "o", "r", { protect: { copilot_review: true } })).toEqual([]);
  });

  it("sets the options it is given and keeps the ones it is not", async () => {
    const { api, writes } = fakeApi({});
    const changes = await planGithub(api, "o", "r", {
      protect: { copilot_review: { review_on_push: true, review_draft_pull_requests: true } },
    });
    expect(rows(changes)).toEqual([["protect", "(none)", `${BASE}; Copilot review (each push, drafts)`]]);
    await apply(api, changes);
    expect(writes[0]?.method).toBe("POST");
    expect(copilotRule(writes[0]?.body?.rules)?.parameters).toEqual({
      review_on_push: true,
      review_draft_pull_requests: true,
    });

    const drafts = { type: COPILOT, parameters: { review_draft_pull_requests: true } };
    const kept = fakeApi({ rules: [...plain, drafts] });
    const next = await planGithub(kept.api, "o", "r", { protect: { copilot_review: { review_on_push: true } } });
    expect(rows(next)).toEqual([
      ["protect", `${BASE}; Copilot review (drafts)`, `${BASE}; Copilot review (each push, drafts)`],
    ]);
    await apply(kept.api, next);
    expect(copilotRule(kept.writes[0]?.body?.rules)?.parameters).toEqual({
      review_on_push: true,
      review_draft_pull_requests: true,
    });
  });

  it("treats a parameter GitHub leaves out as false", async () => {
    const bare = { type: COPILOT };
    expect(
      await planGithub(fakeApi({ rules: [...plain, bare] }).api, "o", "r", { protect: { copilot_review: true } }),
    ).toEqual([]);
  });

  it("removes the rule with false and keeps the other rules", async () => {
    const linear = { type: "required_linear_history" };
    const { api, writes } = fakeApi({ rules: [...plain, linear, { type: COPILOT }] });
    const changes = await planGithub(api, "o", "r", { protect: { copilot_review: false } });
    expect(rows(changes)).toEqual([["protect", `${BASE}; Copilot review`, BASE]]);
    await apply(api, changes);
    expect(writes[0]?.body?.rules.map((r) => r.type)).toEqual(["pull_request", "non_fast_forward", linear.type]);
  });

  it("writes the ruleset without the rule and warns when GitHub refuses it", async () => {
    for (const rules of [undefined, plain]) {
      const warnings: string[] = [];
      const { api, writes } = fakeApi({ rules, noCopilot: true });
      const changes = await planGithub(
        api,
        "o",
        "r",
        { protect: { required_approvals: 1, copilot_review: true } },
        { warn: (message) => warnings.push(message) },
      );
      await apply(api, changes);
      expect(writes.map((w) => w.method)).toEqual([rules ? "PUT" : "POST"]);
      expect(copilotRule(writes[0]?.body?.rules)).toBeUndefined();
      expect(writes[0]?.body?.rules[0]).toMatchObject({ parameters: { required_approving_review_count: 1 } });
      expect(warnings).toEqual([
        expect.stringMatching(
          /^protect\.copilot_review: GitHub refused the Copilot code review rule \(Validation Failed\); the ruleset was written without it\..*Copilot code review on the account that owns o\/r/,
        ),
      ]);
    }
  });

  it("keeps the Copilot rule the ruleset had when GitHub refuses the new one", async () => {
    const before = { type: COPILOT, parameters: { review_on_push: false } };
    const warnings: string[] = [];
    const { api, writes } = fakeApi({ rules: [...plain, before], noCopilot: "on-push" });
    const changes = await planGithub(
      api,
      "o",
      "r",
      { protect: { required_approvals: 2, copilot_review: { review_on_push: true } } },
      { warn: (message) => warnings.push(message) },
    );
    await apply(api, changes);
    expect(writes).toHaveLength(1);
    expect(copilotRule(writes[0]?.body?.rules)).toEqual(before);
    expect(writes[0]?.body?.rules[0]).toMatchObject({ parameters: { required_approving_review_count: 2 } });
    expect(warnings).toHaveLength(1);
  });

  it("does not retry when protect.copilot_review is not asked for", async () => {
    for (const copilot_review of [undefined, false]) {
      const { api, attempts } = fakeApi({ refuse: 422 });
      const changes = await planGithub(api, "o", "r", { protect: { copilot_review } });
      await expect(apply(api, changes)).rejects.toThrow(/creating the repokeeper ruleset failed: Forbidden/);
      expect(attempts).toEqual(["POST /repos/o/r/rulesets"]);
    }
  });

  it("reports GitHub's first answer when the write without the rule is refused too", async () => {
    const warnings: string[] = [];
    const { api, attempts } = fakeApi({ refuse: 403 });
    const changes = await planGithub(
      api,
      "o",
      "r",
      { protect: { copilot_review: true } },
      { warn: (message) => warnings.push(message) },
    );
    await expect(apply(api, changes)).rejects.toThrow(
      /creating the repokeeper ruleset failed: Forbidden; this needs admin access to o\/r/,
    );
    expect(attempts).toHaveLength(2);
    expect(warnings).toEqual([]);
  });
});

describe(".repokeeper.yml: protect.copilot_review", () => {
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

  it("accepts a flag or the two options", () => {
    expect(config(["github:", "  protect: { copilot_review: true }"]).github?.protect).toEqual({
      copilot_review: true,
    });
    expect(
      config(["github:", "  protect: { copilot_review: { review_on_push: true, review_draft_pull_requests: false } }"])
        .github?.protect,
    ).toEqual({ copilot_review: { review_on_push: true, review_draft_pull_requests: false } });
  });

  it("rejects an unknown option", () => {
    expect(() => config(["github:", "  protect: { copilot_review: { review_drafts: true } }"])).toThrow(
      /review_drafts/,
    );
  });
});

describe("repokeeper github apply --yes: Copilot rule refused", () => {
  it("warns, applies the rest of the ruleset and exits 0", async () => {
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
        "  ci: false",
        "github:",
        "  protect:",
        "    copilot_review: true",
        "",
      ].join("\n"),
    );
    const { api, writes } = fakeApi({ noCopilot: true });
    const c = capture(dir);
    const code = await run(["github", "apply", "--yes"], { ...c.io, githubApi: api });
    expect(code).toBe(0);
    expect(c.out).toEqual([
      `change     protect: (none) -> ${BASE}; Copilot review`,
      expect.stringMatching(/^warning {4}protect\.copilot_review: GitHub refused the Copilot code review rule/),
      "applied    protect",
    ]);
    expect(writes).toHaveLength(1);
    expect(copilotRule(writes[0]?.body?.rules)).toBeUndefined();
  });
});
