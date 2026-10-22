import { ApiError } from "../errors.js";
import type { GitHubApi } from "./api.js";
import {
  type GraphPackage,
  indexKey,
  LOCKFILES,
  readLockfile,
  type StalePackage,
  sbomPackages,
  stalePackages,
  type VersionIndex,
} from "./lockfiles.js";

/** A repository of the owner, as the repository list names it. */
export interface RepoRef {
  name: string;
  defaultBranch: string;
  fork: boolean;
  archived: boolean;
}

/** One part of a repository's status, or why it could not be read. */
export type Part<T> = T | { error: string };

export type CheckState = "success" | "failure" | "pending" | "none" | "unknown";

export interface PullRequest {
  number: number;
  author: string;
  title: string;
  checks: CheckState;
}

export type Alerts = { state: "off" } | { state: "on"; total: number; bySeverity: Record<string, number> };

export interface FailedWorkflow {
  name: string;
  conclusion: string;
  /** When the run started; an old failure may be of a workflow that no longer runs on this branch. */
  date: string;
  url: string;
}

export type Ci = { state: "none" } | { state: "success" } | { state: "failure"; workflows: FailedWorkflow[] };

export type Release =
  | { tag: null }
  | {
      tag: string;
      /** Commits on the default branch since the tag. */
      commits: number;
      /** How many of them release-please would release: feat, fix, perf, revert, or a breaking change. */
      releasable: number;
    };

export type Graph =
  | { state: "ok" }
  | { state: "no-lockfile" }
  | { state: "unchecked"; reason: string }
  | { state: "stale"; packages: (StalePackage & { files: string[] })[] };

export interface RepoStatus {
  repo: string;
  defaultBranch: string;
  pulls: Part<PullRequest[]>;
  alerts: Part<Alerts>;
  ci: Part<Ci>;
  release: Part<Release>;
  graph: Part<Graph>;
  /** Why the repository needs attention; empty when it is clean. */
  attention: string[];
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function messageOf(data: unknown): string {
  if (typeof data === "object" && data !== null && "message" in data) return String(data.message);
  return typeof data === "string" && data ? data.slice(0, 200) : "";
}

async function getPage<T = unknown>(api: GitHubApi, path: string): Promise<{ data: T; next?: string }> {
  const { status, data, link } = await api.request("GET", path);
  if (status >= 200 && status < 300) {
    const next = link && /<https?:\/\/[^/>]+([^>]*)>;\s*rel="next"/.exec(link)?.[1];
    return { data: data as T, ...(next ? { next } : {}) };
  }
  const message = messageOf(data);
  if ((status === 403 || status === 429) && /rate limit/i.test(message)) throw new HttpError(status, "rate limited");
  throw new HttpError(status, `HTTP ${status}${message ? `: ${message}` : ""}`);
}

async function get<T = unknown>(api: GitHubApi, path: string): Promise<T> {
  return (await getPage<T>(api, path)).data;
}

/** Every page of a cursor-paginated list, following the `Link` header; stops after `maxPages`. */
async function getCursor<T>(api: GitHubApi, path: string, maxPages = 10): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  for (let page = 0; next !== undefined && page < maxPages; page++) {
    const result: { data: T[]; next?: string } = await getPage<T[]>(api, next);
    if (!Array.isArray(result.data)) break;
    items.push(...result.data);
    next = result.next;
  }
  return items;
}

/** Every page of a list endpoint, 100 at a time; stops after `maxPages`. */
async function getAll<T>(api: GitHubApi, path: string, maxPages = 10): Promise<T[]> {
  const items: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const batch = await get<T[]>(api, `${path}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) break;
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

/** A branch or tag name inside a path: slashes stay, everything else is escaped. */
const segment = (ref: string) => encodeURIComponent(ref).replace(/%2F/g, "/");

async function part<T>(work: () => Promise<T>): Promise<Part<T>> {
  try {
    return await work();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export const isError = (value: unknown): value is { error: string } =>
  typeof value === "object" && value !== null && "error" in value;

interface RawRepo {
  name: string;
  default_branch?: string;
  fork?: boolean;
  archived?: boolean;
  disabled?: boolean;
  owner?: { login?: string };
}

/**
 * The owner's repositories: through `/user/repos` when the token belongs to the owner, which includes the
 * private ones, otherwise the organization's or the user's public list.
 */
export async function listRepos(api: GitHubApi, owner: string, login: string | undefined): Promise<RepoRef[]> {
  let raw: RawRepo[];
  try {
    if (login !== undefined && login.toLowerCase() === owner.toLowerCase()) {
      raw = await getAll<RawRepo>(api, "/user/repos?affiliation=owner");
    } else {
      try {
        raw = await getAll<RawRepo>(api, `/orgs/${segment(owner)}/repos?type=all`);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        raw = await getAll<RawRepo>(api, `/users/${segment(owner)}/repos?type=owner`);
      }
    }
  } catch (error) {
    throw new ApiError(`cannot list the repositories of ${owner}: ${(error as Error).message}`);
  }
  return raw
    .filter((repo) => !repo.disabled && (repo.owner?.login ?? owner).toLowerCase() === owner.toLowerCase())
    .map((repo) => ({
      name: repo.name,
      defaultBranch: repo.default_branch ?? "main",
      fork: repo.fork === true,
      archived: repo.archived === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

interface CheckRun {
  status: string;
  conclusion: string | null;
}

async function checkState(api: GitHubApi, base: string, sha: string): Promise<CheckState> {
  try {
    const result = await get<{ total_count: number; check_runs: CheckRun[] }>(
      api,
      `${base}/commits/${sha}/check-runs?per_page=100`,
    );
    const runs = result.check_runs ?? [];
    if (runs.length === 0) return "none";
    if (runs.some((run) => run.conclusion !== null && FAILED.has(run.conclusion))) return "failure";
    if (runs.some((run) => run.status !== "completed")) return "pending";
    return "success";
  } catch {
    return "unknown";
  }
}

async function pulls(api: GitHubApi, base: string): Promise<PullRequest[]> {
  const open = await getAll<{ number: number; title: string; user?: { login?: string }; head: { sha: string } }>(
    api,
    `${base}/pulls?state=open`,
  );
  return Promise.all(
    open.map(async (pull) => ({
      number: pull.number,
      author: pull.user?.login ?? "?",
      title: pull.title,
      checks: await checkState(api, base, pull.head.sha),
    })),
  );
}

const SEVERITIES = ["critical", "high", "medium", "low"];

async function alerts(api: GitHubApi, base: string): Promise<Alerts> {
  let list: { security_advisory?: { severity?: string }; security_vulnerability?: { severity?: string } }[];
  try {
    list = await getCursor(api, `${base}/dependabot/alerts?state=open`);
  } catch (error) {
    if (error instanceof HttpError && error.status === 403 && /disabled/i.test(error.message)) return { state: "off" };
    throw error;
  }
  const bySeverity: Record<string, number> = {};
  for (const alert of list) {
    const severity = alert.security_advisory?.severity ?? alert.security_vulnerability?.severity ?? "unknown";
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
  }
  const ordered: Record<string, number> = {};
  for (const severity of [...SEVERITIES, ...Object.keys(bySeverity).filter((s) => !SEVERITIES.includes(s))]) {
    if (bySeverity[severity]) ordered[severity] = bySeverity[severity];
  }
  return { state: "on", total: list.length, bySeverity: ordered };
}

interface WorkflowRun {
  name?: string;
  path?: string;
  event?: string;
  conclusion?: string | null;
  created_at?: string;
  html_url?: string;
}

/**
 * The latest conclusive run of each active workflow on the default branch. Dependabot's update jobs and
 * Pages deployments (event `dynamic`) and pull request runs are left out, and so are cancelled or skipped
 * runs, which say nothing about the code.
 */
async function ci(api: GitHubApi, base: string, branch: string): Promise<Ci> {
  const workflows = await get<{ workflows?: { path: string; state: string }[] }>(
    api,
    `${base}/actions/workflows?per_page=100`,
  );
  const active = new Set((workflows.workflows ?? []).filter((w) => w.state === "active").map((w) => w.path));
  if (active.size === 0) return { state: "none" };
  const { workflow_runs: runs = [] } = await get<{ workflow_runs?: WorkflowRun[] }>(
    api,
    `${base}/actions/runs?branch=${encodeURIComponent(branch)}&status=completed&exclude_pull_requests=true&per_page=100`,
  );
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    const path = (run.path ?? "").replace(/@.*$/, "");
    if (run.event === "dynamic" || run.event?.startsWith("pull_request") || !active.has(path)) continue;
    if (run.conclusion !== "success" && !FAILED.has(run.conclusion ?? "")) continue;
    if (!latest.has(path)) latest.set(path, run);
  }
  if (latest.size === 0) return { state: "none" };
  const failed = [...latest.values()].filter((run) => run.conclusion !== "success");
  if (failed.length === 0) return { state: "success" };
  return {
    state: "failure",
    workflows: failed.map((run) => ({
      name: run.name ?? run.path ?? "?",
      conclusion: run.conclusion ?? "?",
      date: (run.created_at ?? "").slice(0, 10),
      url: run.html_url ?? "",
    })),
  };
}

const VERSION = /(\d+)\.(\d+)\.(\d+)/;

function versionOf(tag: string): number[] | undefined {
  const match = VERSION.exec(tag);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** What release-please releases: feat, fix, perf and revert commits, and any breaking change. */
export function isReleasable(message: string): boolean {
  const [subject = ""] = message.split("\n");
  return (
    /^(feat|fix|perf|revert)(\([^)]*\))?!?:/.test(subject) ||
    /^\w+(\([^)]*\))?!:/.test(subject) ||
    /^BREAKING[ -]CHANGE:/m.test(message)
  );
}

async function release(api: GitHubApi, base: string, branch: string): Promise<Release> {
  let tag: string | undefined;
  try {
    tag = (await get<{ tag_name: string }>(api, `${base}/releases/latest`)).tag_name;
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
  }
  if (tag === undefined) {
    let best: number[] | undefined;
    for (const { name } of await getAll<{ name: string }>(api, `${base}/tags`, 3)) {
      const version = versionOf(name);
      if (!version) continue;
      const newer = !best || compareParts(version, best) > 0;
      if (newer) {
        best = version;
        tag = name;
      }
    }
  }
  if (tag === undefined) return { tag: null };
  const compare = await get<{ ahead_by: number; commits?: { commit: { message: string } }[] }>(
    api,
    `${base}/compare/${segment(tag)}...${segment(branch)}?per_page=100`,
  );
  const releasable = (compare.commits ?? []).filter((c) => isReleasable(c.commit.message)).length;
  return { tag, commits: compare.ahead_by, releasable };
}

const MAX_LOCKFILES = 30;

async function graph(api: GitHubApi, base: string, branch: string): Promise<Graph> {
  let tree: { truncated?: boolean; tree?: { path: string; type: string; sha: string }[] };
  try {
    tree = await get(api, `${base}/git/trees/${segment(branch)}?recursive=1`);
  } catch (error) {
    // 409: the repository is empty
    if (error instanceof HttpError && (error.status === 409 || error.status === 404)) return { state: "no-lockfile" };
    throw error;
  }
  const lockfiles = (tree.tree ?? []).filter(
    (entry) =>
      entry.type === "blob" &&
      !/(^|\/)node_modules\//.test(entry.path) &&
      entry.path.slice(entry.path.lastIndexOf("/") + 1) in LOCKFILES,
  );
  if (lockfiles.length === 0) {
    return tree.truncated ? { state: "unchecked", reason: "file tree too large" } : { state: "no-lockfile" };
  }
  let sbom: unknown;
  try {
    sbom = await get(api, `${base}/dependency-graph/sbom`);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 403)) {
      return { state: "unchecked", reason: "dependency graph unavailable" };
    }
    throw error;
  }
  const packages: GraphPackage[] = sbomPackages(sbom);
  const ecosystems = new Set(packages.map((p) => p.ecosystem));
  const index: VersionIndex = new Map();
  const perFile = new Map<string, VersionIndex>();
  const unread: string[] = [];
  for (const file of lockfiles.slice(0, MAX_LOCKFILES)) {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    const ecosystem = LOCKFILES[name];
    if (ecosystem === undefined || !ecosystems.has(ecosystem)) continue;
    try {
      const blob = await get<{ content: string; encoding: string }>(api, `${base}/git/blobs/${file.sha}`);
      const text = Buffer.from(blob.content ?? "", blob.encoding === "base64" ? "base64" : "utf8").toString("utf8");
      const own: VersionIndex = new Map();
      readLockfile(file.path, text, own);
      perFile.set(file.path, own);
      for (const [key, versions] of own) {
        const all = index.get(key) ?? new Set<string>();
        for (const version of versions) all.add(version);
        index.set(key, all);
      }
    } catch {
      unread.push(file.path);
    }
  }
  const stale = stalePackages(packages, index).map((pkg) => ({
    ...pkg,
    files: [...perFile].filter(([, own]) => own.has(indexKey(pkg.ecosystem, pkg.name))).map(([path]) => path),
  }));
  if (stale.length > 0) return { state: "stale", packages: stale };
  if (unread.length > 0) return { state: "unchecked", reason: `could not read ${unread.join(", ")}` };
  return { state: "ok" };
}

/** Collects the status of one repository; a part that fails carries its error instead of stopping the rest. */
export async function repoStatus(api: GitHubApi, owner: string, repo: RepoRef): Promise<RepoStatus> {
  const base = `/repos/${segment(owner)}/${segment(repo.name)}`;
  const branch = repo.defaultBranch;
  const [pullList, alertState, ciState, releaseState, graphState] = await Promise.all([
    part(() => pulls(api, base)),
    part(() => alerts(api, base)),
    part(() => ci(api, base, branch)),
    part(() => release(api, base, branch)),
    part(() => graph(api, base, branch)),
  ]);
  const attention: string[] = [];
  const failed = (name: string, value: unknown) => isError(value) && attention.push(`${name} unreadable`);
  failed("pull requests", pullList);
  failed("alerts", alertState);
  failed("ci", ciState);
  failed("release", releaseState);
  failed("graph", graphState);
  if (!isError(pullList) && pullList.length > 0) attention.push("open pull requests");
  if (!isError(alertState) && alertState.state === "on" && alertState.total > 0) attention.push("dependabot alerts");
  if (!isError(ciState) && ciState.state === "failure") attention.push("failing ci");
  if (!isError(releaseState) && releaseState.tag !== null && releaseState.releasable > 0) {
    attention.push("unreleased changes");
  }
  if (!isError(graphState) && graphState.state === "stale") attention.push("stale dependency graph");
  return {
    repo: repo.name,
    defaultBranch: branch,
    pulls: pullList,
    alerts: alertState,
    ci: ciState,
    release: releaseState,
    graph: graphState,
    attention,
  };
}

/** Runs `work` on every item, at most `limit` at a time, keeping the order. */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
