import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ApiError } from "../errors.js";

export interface ApiResponse {
  status: number;
  data: unknown;
}

/** The slice of the GitHub REST API `github apply` needs; tests pass a fake. */
export interface GitHubApi {
  request(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<ApiResponse>;
}

const execFileAsync = promisify(execFile);

/** `GITHUB_TOKEN`, or the token of the GitHub CLI. */
export async function resolveToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { encoding: "utf8" });
    if (stdout.trim()) return stdout.trim();
  } catch {
    // fall through to the error below
  }
  throw new ApiError("no GitHub token: set GITHUB_TOKEN or sign in with `gh auth login`");
}

export function restApi(token: string, base = "https://api.github.com"): GitHubApi {
  return {
    async request(method, path, body) {
      let response: Response;
      try {
        response = await fetch(`${base}${path}`, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new ApiError(`GitHub API ${method} ${path} failed: ${(error as Error).message}`);
      }
      const text = await response.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { status: response.status, data };
    },
  };
}
