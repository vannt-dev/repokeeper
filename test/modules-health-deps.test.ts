import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { FileOutput } from "../src/model.js";
import { depsModule } from "../src/modules/deps.js";
import { healthModule } from "../src/modules/health.js";
import { makeContext } from "./helpers.js";

const files = (outputs: ReturnType<typeof healthModule.outputs>) =>
  Object.fromEntries(outputs.map((o) => [o.path, (o as FileOutput).content]));

describe("health", () => {
  it("writes the community health files", () => {
    const out = files(healthModule.outputs(makeContext()));
    expect(Object.keys(out).sort()).toEqual([
      ".github/CODEOWNERS",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/pull_request_template.md",
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "LICENSE",
      "SECURITY.md",
    ]);
    expect(out.LICENSE).toContain("Copyright (c) 2026 Van Nguyen");
    expect(out["CODE_OF_CONDUCT.md"]).toContain("https://github.com/vannt-dev");
    expect(out["CODE_OF_CONDUCT.md"]).not.toContain("[INSERT CONTACT METHOD]");
    expect(out["SECURITY.md"]).toContain("https://github.com/vannt-dev/example/security/advisories/new");
    expect(out["CONTRIBUTING.md"]).toContain("`npm install`");
    expect(out[".github/CODEOWNERS"]).toContain("* @vannt-dev");
    for (const path of Object.keys(out).filter((p) => p.endsWith(".yml")))
      expect(() => parse(out[path] as string)).not.toThrow();
  });

  it("omits CODEOWNERS and the advisory link when the owner is unknown", () => {
    const ctx = makeContext({
      repo: { owner: null, name: "x" },
      modules: { health: { license: "MIT", copyright: "2026 A", contact: "a@example.com", codeowners: [] } },
    });
    const out = files(healthModule.outputs(ctx));
    expect(out[".github/CODEOWNERS"]).toBeUndefined();
    expect(out["SECURITY.md"]).toContain("Security tab");
    expect(parse(out[".github/ISSUE_TEMPLATE/config.yml"] as string).contact_links).toEqual([]);
  });

  it("leaves licensing alone when license is false and rejects unbundled licenses", () => {
    const off = makeContext({ modules: { health: { license: false, copyright: "x", contact: "x", codeowners: [] } } });
    expect(files(healthModule.outputs(off)).LICENSE).toBeUndefined();
    const apache = makeContext({
      modules: { health: { license: "Apache-2.0", copyright: "x", contact: "x", codeowners: [] } },
    });
    expect(() => healthModule.outputs(apache)).toThrow(/Apache-2.0/);
  });

  it("is disabled when modules.health is false", () => {
    expect(healthModule.enabled(makeContext({ modules: { health: false } }).config)).toBe(false);
  });
});

describe("deps", () => {
  it("configures weekly grouped updates for each ecosystem plus GitHub Actions", () => {
    const [output] = depsModule.outputs(makeContext());
    expect(output?.path).toBe(".github/dependabot.yml");
    const config = parse((output as FileOutput).content);
    expect(config.version).toBe(2);
    expect(config.updates.map((u: { "package-ecosystem": string }) => u["package-ecosystem"])).toEqual([
      "npm",
      "github-actions",
    ]);
    expect(config.updates[0].schedule).toEqual({ interval: "weekly" });
    expect(config.updates[0].groups["npm-minor-and-patch"]["update-types"]).toEqual(["minor", "patch"]);
    // @types/node majors follow the Node.js line the project runs on, not the latest release
    expect(config.updates[0].ignore).toEqual([
      { "dependency-name": "@types/node", "update-types": ["version-update:semver-major"] },
    ]);
    expect(config.updates[1].ignore).toBeUndefined();
  });
});
