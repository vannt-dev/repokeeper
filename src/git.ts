import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { PlatformId } from "./config/types.js";
import type { RepoInfo } from "./model.js";

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    return stdout;
  } catch {
    return null;
  }
}

export async function isGitRepo(root: string): Promise<boolean> {
  return (await git(root, ["rev-parse", "--is-inside-work-tree"]))?.trim() === "true";
}

export function parseRemoteUrl(url: string): { owner: string; name: string } | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? { owner: match[1] as string, name: match[2] as string } : null;
}

export interface Remote {
  host: string;
  owner: string;
  name: string;
}

/** Any hosted remote, HTTPS or SSH. The owner is the whole namespace path, because GitLab groups nest. */
export function parseRemote(url: string): Remote | null {
  const text = url.trim();
  const match =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(text) ??
    /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(text);
  if (!match) return null;
  const host = (match[1] as string).toLowerCase();
  const segments = (match[2] as string)
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  const name = segments.pop();
  // a host has a dot, which rules out drive letters and file: URLs
  if (!host.includes(".") || name === undefined || segments.length === 0) return null;
  return { host, owner: segments.join("/"), name };
}

async function originUrl(root: string): Promise<string | null> {
  return git(root, ["remote", "get-url", "origin"]);
}

/** Host of the origin remote, or null without one. */
export async function remoteHost(root: string): Promise<string | null> {
  const url = await originUrl(root);
  return url ? (parseRemote(url)?.host ?? null) : null;
}

export async function repoInfo(root: string, platform: PlatformId = "github"): Promise<RepoInfo> {
  const url = await originUrl(root);
  const remote = url ? (platform === "gitlab" ? parseRemote(url) : parseRemoteUrl(url)) : null;
  return { ...(remote ?? { owner: null, name: basename(root) }), releasedVersion: await latestReleaseVersion(root) };
}

/** The branch `origin/HEAD` points at, or null when the remote's default branch isn't known locally. */
export async function remoteDefaultBranch(root: string): Promise<string | null> {
  const ref = (await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.trim();
  return ref?.startsWith("origin/") ? ref.slice("origin/".length) : null;
}

/** The highest `vX.Y.Z` tag as `X.Y.Z`; major tags such as `v0` are skipped. */
export async function latestReleaseVersion(root: string): Promise<string | null> {
  const tags = (await git(root, ["tag", "--list", "v*", "--sort=-v:refname"])) ?? "";
  const tag = tags.split("\n").find((t) => /^v\d+\.\d+\.\d+$/.test(t.trim()));
  return tag ? tag.trim().slice(1) : null;
}

/** Tracked files git stores with CRLF line endings; `.gitattributes` only reaches them after a renormalize. */
export async function crlfTrackedFiles(root: string): Promise<string[]> {
  const out = (await git(root, ["ls-files", "--eol"])) ?? "";
  return out
    .split("\n")
    .filter((line) => line.startsWith("i/crlf"))
    .map((line) => line.split("\t").pop() as string);
}

export async function gitUserName(root: string): Promise<string | null> {
  return (await git(root, ["config", "user.name"]))?.trim() || null;
}

export interface DirtyPath {
  path: string;
  untracked: boolean;
}

/** Paths among `paths` with uncommitted changes, including untracked files. Empty outside git. */
export async function dirtyPaths(root: string, paths: string[]): Promise<DirtyPath[]> {
  if (paths.length === 0 || !(await isGitRepo(root))) return [];
  const out = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths]);
  if (!out) return [];
  const tokens = out.split("\0").filter(Boolean);
  const dirty: DirtyPath[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    dirty.push({ path: token.slice(3), untracked: token.startsWith("??") });
    if (token.startsWith("R") || token.startsWith("C")) i++;
  }
  return dirty;
}
