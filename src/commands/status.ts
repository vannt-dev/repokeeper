import type { Io } from "../cli.js";
import { UsageError } from "../errors.js";
import { type GitHubApi, resolveToken, restApi } from "../github/api.js";
import { isError, listRepos, mapLimit, type RepoStatus, repoStatus } from "../github/status.js";
import type { CommandOptions } from "./report.js";

/** How many repositories are read at the same time; each one makes about ten requests. */
const CONCURRENCY = 4;

export const REREAD_HINT = "a commit touching the manifest makes GitHub re-read it";

function pullsCell(status: RepoStatus): string {
  return isError(status.pulls) ? "error" : String(status.pulls.length);
}

function alertsCell(status: RepoStatus): string {
  const alerts = status.alerts;
  if (isError(alerts)) return "error";
  if (alerts.state === "off") return "off";
  if (alerts.total === 0) return "0";
  return Object.entries(alerts.bySeverity)
    .map(([severity, count]) => `${count} ${severity}`)
    .join(", ");
}

function ciCell(status: RepoStatus): string {
  const ci = status.ci;
  if (isError(ci)) return "error";
  return ci.state === "success" ? "ok" : ci.state === "failure" ? "failed" : "none";
}

function releaseCell(status: RepoStatus): string {
  const release = status.release;
  if (isError(release)) return "error";
  if (release.tag === null) return "no tags";
  const releasable = release.releasable > 0 ? ` (${release.releasable} feat/fix)` : "";
  return `${release.commits} since ${release.tag}${releasable}`;
}

function graphCell(status: RepoStatus): string {
  const graph = status.graph;
  if (isError(graph)) return "error";
  if (graph.state === "stale") return `stale (${graph.packages.length})`;
  if (graph.state === "no-lockfile") return "-";
  return graph.state;
}

function standardCell(status: RepoStatus): string {
  const standard = status.standard;
  if (isError(standard)) return "error";
  if (standard.state === "none") return "-";
  if (standard.state === "behind") return `${standard.version} (${standard.current} out)`;
  if (standard.state === "ahead") return `${standard.version} (newer than this repokeeper)`;
  return standard.version;
}

function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? [];
  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

/** The human report: a table of the repositories to show, then the details behind it. */
export function renderStatus(statuses: RepoStatus[], all: boolean): string[] {
  const attention = statuses.filter((s) => s.attention.length > 0);
  const shown = all ? statuses : attention;
  const lines: string[] = [];
  if (shown.length > 0) {
    lines.push(
      ...table([
        ["repo", "prs", "alerts", "ci", "unreleased", "graph", "standard"],
        ...shown.map((s) => [
          s.repo,
          pullsCell(s),
          alertsCell(s),
          ciCell(s),
          releaseCell(s),
          graphCell(s),
          standardCell(s),
        ]),
      ]),
    );
  }
  const pulls = shown.flatMap((s) =>
    isError(s.pulls) ? [] : s.pulls.map((p) => [`${s.repo}#${p.number}`, p.author, `checks ${p.checks}`, p.title]),
  );
  if (pulls.length > 0) lines.push("", "open pull requests:", ...table(pulls).map((line) => `  ${line}`));
  const failing = shown.flatMap((s) =>
    !isError(s.ci) && s.ci.state === "failure"
      ? s.ci.workflows.map((w) => `  ${s.repo}: ${w.name} ${w.conclusion} on ${w.date} ${w.url}`)
      : [],
  );
  if (failing.length > 0) lines.push("", "failing workflows on the default branch:", ...failing);
  const stale = shown.flatMap((s) =>
    !isError(s.graph) && s.graph.state === "stale"
      ? s.graph.packages.map(
          (p) =>
            `  ${s.repo}: ${p.ecosystem} ${p.name} ${p.version} in the graph, ${p.lockfile.join(", ")} in ${p.files.join(", ") || "the lockfile"}`,
        )
      : [],
  );
  if (stale.length > 0) {
    lines.push("", `stale dependency graph (GitHub still reads old versions; ${REREAD_HINT}):`, ...stale);
  }
  const behind = shown.filter((s) => !isError(s.standard) && s.standard.state === "behind").map((s) => s.repo);
  if (behind.length > 0) lines.push("", `standard behind: ${behind.join(", ")} (run \`repokeeper update\` there)`);
  const unchecked = shown.flatMap((s) =>
    !isError(s.graph) && s.graph.state === "unchecked" ? [`  ${s.repo}: graph unchecked, ${s.graph.reason}`] : [],
  );
  const errors = shown.flatMap((s) =>
    (["pulls", "alerts", "ci", "release", "graph", "standard"] as const).flatMap((key) => {
      const value = s[key];
      return isError(value) ? [`  ${s.repo}: ${key}: ${value.error}`] : [];
    }),
  );
  if (errors.length + unchecked.length > 0) lines.push("", "could not check:", ...errors, ...unchecked);
  if (errors.some((line) => line.includes("rate limited"))) {
    lines.push("note: GitHub's rate limit was reached; run again once it resets");
  }
  const clean = statuses.length - attention.length;
  if (lines.length > 0) lines.push("");
  lines.push(
    attention.length === 0
      ? `all ${statuses.length} repositories clean`
      : `${clean} of ${statuses.length} repositories clean, ${attention.length} need attention`,
  );
  return lines;
}

async function login(api: GitHubApi): Promise<string | undefined> {
  try {
    const { status, data } = await api.request("GET", "/user");
    if (status === 200 && typeof data === "object" && data !== null && "login" in data) return String(data.login);
  } catch {}
  return undefined;
}

/** `repokeeper github status`: what needs attention across every repository of an owner. */
export async function githubStatusCommand(options: CommandOptions, io: Io): Promise<number> {
  const api = io.githubApi ?? restApi(await resolveToken());
  const user = await login(api);
  const owner = options.owner ?? user;
  if (owner === undefined) throw new UsageError("cannot tell whose repositories to read; pass --owner <name>");
  const repos = (await listRepos(api, owner, user)).filter((repo) => !repo.archived && (options.forks || !repo.fork));
  const statuses = await mapLimit(repos, CONCURRENCY, (repo) => repoStatus(api, owner, repo));
  const needAttention = statuses.some((s) => s.attention.length > 0);
  if (options.json) {
    const clean = statuses.filter((s) => s.attention.length === 0).length;
    io.out(JSON.stringify({ owner, clean, repositories: statuses }, null, 2));
  } else {
    for (const line of renderStatus(statuses, options.all ?? false)) io.out(line);
  }
  return options.exitCode && needAttention ? 1 : 0;
}
