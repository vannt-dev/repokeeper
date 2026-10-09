import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ApiError } from "../errors.js";
import type { ApiResponse } from "../github/api.js";

/** The slice of the GitLab REST API `gitlab apply` needs; tests pass a fake. */
export interface GitLabApi {
  request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<ApiResponse>;
}

const execFileAsync = promisify(execFile);

/** `GITLAB_TOKEN`, or the token the GitLab CLI holds for the host. */
export async function resolveGitlabToken(host: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.GITLAB_TOKEN) return env.GITLAB_TOKEN;
  try {
    const { stdout } = await execFileAsync("glab", ["config", "get", "token", "--host", host], { encoding: "utf8" });
    if (stdout.trim()) return stdout.trim();
  } catch {
    // fall through to the error below
  }
  throw new ApiError(`no GitLab token for ${host}: set GITLAB_TOKEN or sign in with \`glab auth login\``);
}

export function gitlabRestApi(token: string, host: string): GitLabApi {
  const base = `https://${host}/api/v4`;
  return {
    async request(method, path, body) {
      let response: Response;
      try {
        response = await fetch(`${base}${path}`, {
          method,
          headers: {
            accept: "application/json",
            // read as a personal, project or group access token, and as the OAuth token of `glab`
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new ApiError(`GitLab API ${method} ${path} failed: ${(error as Error).message}`);
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
