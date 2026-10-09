import { ApiError } from "../errors.js";
import type { ApiResponse } from "../github/api.js";
import type { GitLabApi } from "./api.js";

export const ACCESS_LEVELS = { none: 0, developers: 30, maintainers: 40 } as const;
export type AccessLevel = keyof typeof ACCESS_LEVELS;

/** The `gitlab:` section of .repokeeper.yml. Only the keys present are managed. */
export interface GitlabSettings {
  default_branch?: string;
  description?: string;
  topics?: string[];
  merge?: {
    /** `merge`: a merge commit; `rebase_merge`: a merge commit after a rebase; `ff`: fast-forward only. */
    method?: "merge" | "rebase_merge" | "ff";
    squash?: "never" | "always" | "default_on" | "default_off";
    delete_source_branch?: boolean;
    pipeline_must_succeed?: boolean;
    discussions_must_be_resolved?: boolean;
  };
  /** Protection of the default branch; false removes it. Left-out keys are GitLab's own defaults. */
  protect?: { push?: AccessLevel; merge?: AccessLevel; allow_force_push?: boolean } | false;
  /** Cron line (UTC) of the pipeline schedule that runs the renovate job; false removes the schedule. */
  renovate_schedule?: string | false;
}

export interface GitlabChange {
  setting: string;
  from: string;
  to: string;
  apply(api: GitLabApi): Promise<void>;
}

export interface GitlabPlan {
  changes: GitlabChange[];
  /** What `apply` leaves to a person: the secrets the generated jobs wait for. */
  notes: string[];
}

/** Description of the pipeline schedule repokeeper owns; a schedule under another name is never touched. */
export const RENOVATE_SCHEDULE = "repokeeper: renovate";

const MERGE_FIELDS = {
  method: "merge_method",
  squash: "squash_option",
  delete_source_branch: "remove_source_branch_after_merge",
  pipeline_must_succeed: "only_allow_merge_if_pipeline_succeeds",
  discussions_must_be_resolved: "only_allow_merge_if_all_discussions_are_resolved",
} as const;

function expect2xx(response: ApiResponse, what: string, project: string): ApiResponse {
  if (response.status < 400) return response;
  const data = response.data as { message?: unknown; error?: unknown } | null;
  const said = data?.message ?? data?.error;
  const message = typeof said === "string" ? said : said ? JSON.stringify(said) : `HTTP ${response.status}`;
  const access =
    response.status === 401 || response.status === 403 || response.status === 404
      ? `; this needs the Maintainer role on ${project} and a token with the api scope`
      : "";
  throw new ApiError(`${what} failed: ${message}${access}`);
}

const show = (value: unknown) =>
  value === undefined || value === null || value === ""
    ? "(none)"
    : Array.isArray(value)
      ? value.join(", ") || "(none)"
      : String(value);

interface Protection {
  push: number[];
  merge: number[];
  forcePush: boolean;
}

interface ProtectedBranch {
  push_access_levels?: { access_level: number | null }[];
  merge_access_levels?: { access_level: number | null }[];
  allow_force_push?: boolean;
}

const levels = (list: { access_level: number | null }[] | undefined) =>
  (list ?? []).map((entry) => entry.access_level ?? -1).sort((a, b) => a - b);

const levelName = (level: number): string =>
  Object.entries(ACCESS_LEVELS).find(([, value]) => value === level)?.[0] ??
  // a user, a group or a deploy key allowed by name (paid tiers), or a level repokeeper has no word for
  (level === -1 ? "named members" : `level ${level}`);

const describeLevels = (list: number[]) => (list.length === 0 ? "none" : list.map(levelName).join(" + "));

function describeProtection(protection: Protection | null): string {
  if (protection === null) return "(not protected)";
  return [
    `push: ${describeLevels(protection.push)}`,
    `merge: ${describeLevels(protection.merge)}`,
    protection.forcePush ? "force push allowed" : "no force push",
  ].join("; ");
}

interface Schedule {
  id: number;
  description: string;
  ref: string;
  cron: string;
  active: boolean;
}

const branchOf = (ref: string) => ref.replace(/^refs\/heads\//, "");

const describeSchedule = (schedule: Pick<Schedule, "cron" | "ref" | "active"> | undefined) =>
  schedule === undefined
    ? "(none)"
    : `${schedule.cron} on ${branchOf(schedule.ref)}${schedule.active ? "" : " (inactive)"}`;

/**
 * Reads the project's current settings and lists what differs from `settings`. Reads only.
 *
 * @param secrets CI/CD variables the generated jobs wait for; a missing one is reported, never created.
 */
export async function planGitlab(
  api: GitLabApi,
  path: string,
  settings: GitlabSettings,
  secrets: Array<{ key: string; job: string }> = [],
): Promise<GitlabPlan> {
  const base = `/projects/${encodeURIComponent(path)}`;
  const get = async (suffix: string, what: string, missingOk = false) => {
    const response = await api.request("GET", `${base}${suffix}`);
    return missingOk && response.status === 404 ? response : expect2xx(response, what, path);
  };
  const send = async (method: "POST" | "PUT" | "DELETE", suffix: string, what: string, body?: unknown) => {
    expect2xx(await api.request(method, `${base}${suffix}`, body), what, path);
  };
  const changes: GitlabChange[] = [];
  const current = (await get("", `reading ${path}`)).data as Record<string, unknown>;

  for (const [key, field] of Object.entries(MERGE_FIELDS) as [keyof typeof MERGE_FIELDS, string][]) {
    const want = settings.merge?.[key];
    if (want === undefined || current[field] === want) continue;
    changes.push({
      setting: `merge.${key}`,
      from: show(current[field]),
      to: show(want),
      apply: () => send("PUT", "", `setting merge.${key}`, { [field]: want }),
    });
  }

  if (settings.description !== undefined && (current.description ?? "") !== settings.description) {
    const description = settings.description;
    changes.push({
      setting: "description",
      from: show(current.description),
      to: show(description),
      apply: () => send("PUT", "", "setting the description", { description }),
    });
  }

  if (settings.topics !== undefined) {
    const have = ((current.topics as string[] | undefined) ?? []).slice().sort();
    const want = [...settings.topics].sort();
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      changes.push({
        setting: "topics",
        from: show(have),
        to: show(want),
        apply: () => send("PUT", "", "setting topics", { topics: want }),
      });
    }
  }

  const branch = settings.default_branch ?? (current.default_branch as string | undefined) ?? "main";

  if (settings.protect !== undefined) {
    const rule = `/protected_branches/${encodeURIComponent(branch)}`;
    const response = await get(rule, `reading the protection of ${branch}`, true);
    const existing = response.status === 404 ? null : (response.data as ProtectedBranch);
    const have: Protection | null = existing && {
      push: levels(existing.push_access_levels),
      merge: levels(existing.merge_access_levels),
      forcePush: existing.allow_force_push === true,
    };
    if (settings.protect === false) {
      if (have) {
        changes.push({
          setting: `protect ${branch}`,
          from: describeProtection(have),
          to: describeProtection(null),
          apply: () => send("DELETE", rule, `removing the protection of ${branch}`),
        });
      }
    } else {
      const want: Protection = {
        push: [ACCESS_LEVELS[settings.protect.push ?? "maintainers"]],
        merge: [ACCESS_LEVELS[settings.protect.merge ?? "maintainers"]],
        forcePush: settings.protect.allow_force_push ?? false,
      };
      if (JSON.stringify(have) !== JSON.stringify(want)) {
        changes.push({
          setting: `protect ${branch}`,
          from: describeProtection(have),
          to: describeProtection(want),
          // a protection is replaced as a whole: changing its access levels in place needs the id of each one
          apply: async () => {
            if (have) await send("DELETE", rule, `removing the protection of ${branch}`);
            await send("POST", "/protected_branches", `protecting ${branch}`, {
              name: branch,
              push_access_level: want.push[0],
              merge_access_level: want.merge[0],
              allow_force_push: want.forcePush,
            });
          },
        });
      }
    }
  }

  if (settings.renovate_schedule !== undefined) {
    const list = (await get("/pipeline_schedules", "reading the pipeline schedules")).data as Schedule[];
    const existing = list.find((schedule) => schedule.description === RENOVATE_SCHEDULE);
    const cron = settings.renovate_schedule;
    if (cron === false) {
      if (existing) {
        changes.push({
          setting: "renovate_schedule",
          from: describeSchedule(existing),
          to: describeSchedule(undefined),
          apply: () => send("DELETE", `/pipeline_schedules/${existing.id}`, "removing the renovate schedule"),
        });
      }
    } else if (!existing || existing.cron !== cron || branchOf(existing.ref) !== branch || !existing.active) {
      const want = { cron, ref: branch, active: true };
      changes.push({
        setting: "renovate_schedule",
        from: describeSchedule(existing),
        to: describeSchedule(want),
        apply: () =>
          existing
            ? send("PUT", `/pipeline_schedules/${existing.id}`, "updating the renovate schedule", want)
            : send("POST", "/pipeline_schedules", "creating the renovate schedule", {
                description: RENOVATE_SCHEDULE,
                cron_timezone: "UTC",
                ...want,
              }),
      });
    }
  }

  const notes: string[] = [];
  for (const { key, job } of secrets) {
    const response = await api.request("GET", `${base}/variables/${key}`);
    if (response.status === 404) {
      notes.push(
        `no CI/CD variable ${key} in ${path}: the ${job} job stays inactive until one is set, here or in a group above`,
      );
    } else if (response.status >= 400) {
      notes.push(`could not read the CI/CD variables of ${path} (HTTP ${response.status}); ${key} was not checked`);
    }
  }
  return { changes, notes };
}
