import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import type { ApiResponse, GitHubApi } from "../src/github/api.js";
import { planGithub } from "../src/github/settings.js";

type Status = "enabled" | "disabled";

/** A fake GitHub holding the two switches the way `GET /repos/{owner}/{repo}` reports them. */
function fakeApi(state: { scanning?: Status; pushProtection?: Status; refuse?: string }) {
  const writes: { method: string; path: string; body?: unknown }[] = [];
  const api: GitHubApi = {
    async request(method, path, body): Promise<ApiResponse> {
      if (method !== "GET") {
        if (state.refuse) return { status: 422, data: { message: state.refuse } };
        writes.push({ method, path, body });
        return { status: 200, data: {} };
      }
      if (path !== "/repos/o/r") return { status: 404, data: { message: "Not Found" } };
      const analysis: Record<string, { status: Status }> = {};
      if (state.scanning) analysis.secret_scanning = { status: state.scanning };
      if (state.pushProtection) analysis.secret_scanning_push_protection = { status: state.pushProtection };
      // a token without admin access does not see the key at all
      return { status: 200, data: Object.keys(analysis).length > 0 ? { security_and_analysis: analysis } : {} };
    },
  };
  return { api, writes };
}

const apply = async (api: GitHubApi, changes: Awaited<ReturnType<typeof planGithub>>) => {
  for (const change of changes) await change.apply(api);
};
const both = { security: { secret_scanning: true, secret_scanning_push_protection: true } };

describe("github apply: secret scanning", () => {
  it("turns on secret scanning before push protection, which needs it", async () => {
    const { api, writes } = fakeApi({ scanning: "disabled", pushProtection: "disabled" });
    const changes = await planGithub(api, "o", "r", both);
    expect(changes.map((c) => [c.setting, c.from, c.to])).toEqual([
      ["security.secret_scanning", "false", "true"],
      ["security.secret_scanning_push_protection", "false", "true"],
    ]);
    await apply(api, changes);
    expect(writes).toEqual([
      {
        method: "PATCH",
        path: "/repos/o/r",
        body: { security_and_analysis: { secret_scanning: { status: "enabled" } } },
      },
      {
        method: "PATCH",
        path: "/repos/o/r",
        body: { security_and_analysis: { secret_scanning_push_protection: { status: "enabled" } } },
      },
    ]);
  });

  it("changes nothing when both are as asked, or when the configuration leaves them out", async () => {
    const enabled = fakeApi({ scanning: "enabled", pushProtection: "enabled" });
    expect(await planGithub(enabled.api, "o", "r", both)).toEqual([]);
    expect(await planGithub(fakeApi({ scanning: "disabled" }).api, "o", "r", { security: {} })).toEqual([]);
  });

  it("turns one off without touching the other", async () => {
    const { api, writes } = fakeApi({ scanning: "enabled", pushProtection: "enabled" });
    const changes = await planGithub(api, "o", "r", { security: { secret_scanning_push_protection: false } });
    await apply(api, changes);
    expect(writes).toEqual([
      {
        method: "PATCH",
        path: "/repos/o/r",
        body: { security_and_analysis: { secret_scanning_push_protection: { status: "disabled" } } },
      },
    ]);
  });

  it("reads a repository that does not report the switches as having them off", async () => {
    const changes = await planGithub(fakeApi({}).api, "o", "r", { security: { secret_scanning: true } });
    expect(changes.map((c) => [c.setting, c.from, c.to])).toEqual([["security.secret_scanning", "false", "true"]]);
  });

  it("says what GitHub answered when the repository's plan does not include it", async () => {
    const { api } = fakeApi({
      scanning: "disabled",
      refuse: "Secret scanning is not available for this repository.",
    });
    const [change] = await planGithub(api, "o", "r", { security: { secret_scanning: true } });
    await expect(change?.apply(api)).rejects.toThrow(
      /setting security\.secret_scanning failed: Secret scanning is not available for this repository\..*public.*GitHub Secret Protection/,
    );
  });

  it("is accepted in .repokeeper.yml", () => {
    const config = parseConfig(
      [
        "schema: 1",
        "standard: 1.0.0",
        "platform: github",
        "stacks: [node]",
        "modules: { health: false }",
        "github:",
        "  security: { secret_scanning: true, secret_scanning_push_protection: true }",
        "",
      ].join("\n"),
    );
    expect(config.github?.security).toEqual({ secret_scanning: true, secret_scanning_push_protection: true });
  });
});
