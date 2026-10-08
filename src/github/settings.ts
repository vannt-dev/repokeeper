import { ApiError } from "../errors.js";
import type { ApiResponse, GitHubApi } from "./api.js";

/** The `github:` section of .repokeeper.yml. Only the keys present are managed. */
export interface GithubSettings {
  default_branch?: string;
  /**
   * Where the generated CI and release workflows find the reusable workflows they call. Not a
   * setting of the repository on GitHub: `github apply` leaves it alone.
   */
  workflows?: WorkflowSource;
  description?: string;
  topics?: string[];
  merge?: { squash?: boolean; merge_commit?: boolean; rebase?: boolean; delete_branch_on_merge?: boolean };
  security?: { dependabot_alerts?: boolean; dependabot_security_updates?: boolean };
  /** The `repokeeper` ruleset on the default branch; false removes it. */
  protect?:
    | {
        require_pull_request?: boolean;
        required_approvals?: number;
        required_checks?: string[];
        allow_force_push?: boolean;
      }
    | false;
}

export interface WorkflowSource {
  /**
   * `local`: the reusable workflows are files of this repository, written once and then the
   * repository's own. `owner/name`: a repository that holds a copy of them. Left out: repokeeper's.
   */
  source?: string;
  /**
   * What to call them at. `exact`: the release of the repokeeper that wrote the file, moved by
   * `repokeeper update`. Anything else is used as written: a tag, a branch or a commit SHA.
   * Left out: the moving major tag of repokeeper, or `main` of a repository of your own.
   */
  ref?: string;
}

export interface Change {
  setting: string;
  from: string;
  to: string;
  apply(api: GitHubApi): Promise<void>;
}

export const RULESET_NAME = "repokeeper";

function expect2xx(response: ApiResponse, what: string, repo: string): ApiResponse {
  if (response.status < 400) return response;
  const message = (response.data as { message?: string } | null)?.message ?? `HTTP ${response.status}`;
  const access =
    response.status === 403 || response.status === 404
      ? `; this needs admin access to ${repo} (a token with the repo scope, or Administration: write)`
      : "";
  throw new ApiError(`${what} failed: ${message}${access}`);
}

const show = (value: unknown) =>
  value === undefined || value === null || value === ""
    ? "(none)"
    : Array.isArray(value)
      ? value.join(", ") || "(none)"
      : String(value);

const MERGE_FIELDS = {
  squash: "allow_squash_merge",
  merge_commit: "allow_merge_commit",
  rebase: "allow_rebase_merge",
  delete_branch_on_merge: "delete_branch_on_merge",
} as const;

interface RuleSummary {
  pullRequest: boolean;
  approvals: number;
  checks: string[];
  forcePush: boolean;
}

interface Rule {
  type: string;
  parameters?: {
    required_approving_review_count?: number;
    required_status_checks?: { context: string }[];
  };
}

function summarize(rules: Rule[]): RuleSummary {
  const pr = rules.find((r) => r.type === "pull_request");
  const checks = rules.find((r) => r.type === "required_status_checks");
  return {
    pullRequest: pr !== undefined,
    approvals: pr?.parameters?.required_approving_review_count ?? 0,
    checks: (checks?.parameters?.required_status_checks ?? []).map((c) => c.context).sort(),
    forcePush: !rules.some((r) => r.type === "non_fast_forward"),
  };
}

function describeRules(summary: RuleSummary | null): string {
  if (summary === null) return "(none)";
  const parts = [
    summary.pullRequest ? `pull request required (${summary.approvals} approvals)` : "no pull request required",
    summary.checks.length > 0 ? `checks: ${summary.checks.join(", ")}` : "no required checks",
    summary.forcePush ? "force push allowed" : "no force push",
  ];
  return parts.join("; ");
}

function desiredRules(protect: Exclude<GithubSettings["protect"], false | undefined>): Rule[] {
  const rules: Rule[] = [];
  if (protect.require_pull_request ?? true) {
    rules.push({
      type: "pull_request",
      parameters: {
        required_approving_review_count: protect.required_approvals ?? 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      } as Rule["parameters"],
    });
  }
  const checks = protect.required_checks ?? [];
  if (checks.length > 0) {
    rules.push({
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: checks.map((context) => ({ context })),
      } as Rule["parameters"],
    });
  }
  if (!(protect.allow_force_push ?? false)) rules.push({ type: "non_fast_forward" });
  return rules;
}

const sameSummary = (a: RuleSummary, b: RuleSummary) => JSON.stringify(a) === JSON.stringify(b);

/** Reads the repository's current settings and lists what differs from `settings`. Reads only. */
export async function planGithub(
  api: GitHubApi,
  owner: string,
  name: string,
  settings: GithubSettings,
): Promise<Change[]> {
  const repo = `${owner}/${name}`;
  const base = `/repos/${owner}/${name}`;
  const get = async (path: string, what: string, missingOk = false) => {
    const response = await api.request("GET", `${base}${path}`);
    return missingOk && response.status === 404 ? response : expect2xx(response, what, repo);
  };
  const send = async (method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, what: string, body?: unknown) => {
    expect2xx(await api.request(method, `${base}${path}`, body), what, repo);
  };
  const changes: Change[] = [];
  const current = (await get("", `reading ${repo}`)).data as Record<string, unknown>;

  for (const [key, field] of Object.entries(MERGE_FIELDS) as [keyof typeof MERGE_FIELDS, string][]) {
    const want = settings.merge?.[key];
    if (want === undefined || current[field] === want) continue;
    changes.push({
      setting: `merge.${key}`,
      from: show(current[field]),
      to: show(want),
      apply: () => send("PATCH", "", `setting merge.${key}`, { [field]: want }),
    });
  }

  if (settings.description !== undefined && (current.description ?? "") !== settings.description) {
    const description = settings.description;
    changes.push({
      setting: "description",
      from: show(current.description),
      to: show(description),
      apply: () => send("PATCH", "", "setting the description", { description }),
    });
  }

  if (settings.topics !== undefined) {
    const have = (((await get("/topics", "reading topics")).data as { names?: string[] }).names ?? []).slice().sort();
    const want = [...settings.topics].sort();
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      changes.push({
        setting: "topics",
        from: show(have),
        to: show(want),
        apply: () => send("PUT", "/topics", "setting topics", { names: want }),
      });
    }
  }

  const alerts = settings.security?.dependabot_alerts;
  if (alerts !== undefined) {
    const have = (await get("/vulnerability-alerts", "reading Dependabot alerts", true)).status === 204;
    if (have !== alerts) {
      changes.push({
        setting: "security.dependabot_alerts",
        from: show(have),
        to: show(alerts),
        apply: () => send(alerts ? "PUT" : "DELETE", "/vulnerability-alerts", "setting Dependabot alerts"),
      });
    }
  }
  const fixes = settings.security?.dependabot_security_updates;
  if (fixes !== undefined) {
    const response = await get("/automated-security-fixes", "reading Dependabot security updates", true);
    const have = response.status !== 404 && (response.data as { enabled?: boolean } | null)?.enabled === true;
    if (have !== fixes) {
      changes.push({
        setting: "security.dependabot_security_updates",
        from: show(have),
        to: show(fixes),
        apply: () => send(fixes ? "PUT" : "DELETE", "/automated-security-fixes", "setting Dependabot security updates"),
      });
    }
  }

  if (settings.protect !== undefined) {
    const list = (await get("/rulesets?includes_parents=false", "reading rulesets")).data as {
      id: number;
      name: string;
    }[];
    const existing = list.find((r) => r.name === RULESET_NAME);
    const detail = existing
      ? ((await get(`/rulesets/${existing.id}`, "reading the repokeeper ruleset")).data as {
          enforcement?: string;
          conditions?: { ref_name?: { include?: string[] } };
          rules?: Rule[];
        })
      : null;
    const have = detail ? summarize(detail.rules ?? []) : null;
    if (settings.protect === false) {
      if (existing) {
        changes.push({
          setting: "protect",
          from: describeRules(have),
          to: "(none)",
          apply: () => send("DELETE", `/rulesets/${existing.id}`, "removing the repokeeper ruleset"),
        });
      }
    } else {
      const rules = desiredRules(settings.protect);
      const want = summarize(rules);
      const targetsDefault = detail?.conditions?.ref_name?.include?.includes("~DEFAULT_BRANCH") ?? false;
      const upToDate = have !== null && sameSummary(have, want) && detail?.enforcement === "active" && targetsDefault;
      if (!upToDate) {
        const body = {
          name: RULESET_NAME,
          target: "branch",
          enforcement: "active",
          conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
          rules,
        };
        changes.push({
          setting: "protect",
          from: describeRules(have),
          to: describeRules(want),
          apply: () =>
            existing
              ? send("PUT", `/rulesets/${existing.id}`, "updating the repokeeper ruleset", body)
              : send("POST", "/rulesets", "creating the repokeeper ruleset", body),
        });
      }
    }
  }
  return changes;
}
