import { expect, it } from "vitest";
import { parseConfig, renderConfig } from "../src/config/load.js";
import { defaultBranch, defaultConfig } from "../src/config/types.js";

const base = "schema: 1\nstandard: 1.0.0\nplatform: gitlab\nstacks: [node]\nmodules:\n  health: false\n";

it("accepts the gitlab platform and its default branch", () => {
  expect(parseConfig(base).platform).toBe("gitlab");
  expect(defaultBranch(parseConfig(base))).toBe("main");
  expect(defaultBranch(parseConfig(`${base}gitlab:\n  default_branch: trunk\n`))).toBe("trunk");
});

it("rejects the other platform's key, naming it and its line", () => {
  expect(() => parseConfig(`${base}github:\n  default_branch: trunk\n`)).toThrow(
    ".repokeeper.yml:8: github is not used on the gitlab platform",
  );
  const github = base.replace("platform: gitlab", "platform: github");
  expect(() => parseConfig(`${github}gitlab:\n  default_branch: trunk\n`)).toThrow(
    ".repokeeper.yml:8: gitlab is not used on the github platform",
  );
});

it("rejects unknown gitlab keys and unknown platforms", () => {
  expect(() => parseConfig(`${base}gitlab:\n  protect: false\n`)).toThrow("gitlab.protect is not a known key");
  expect(() => parseConfig(base.replace("gitlab", "bitbucket"))).toThrow("platform must be one of: github, gitlab");
});

it("builds and renders a gitlab default config that parses back", () => {
  const config = defaultConfig({
    stacks: ["node"],
    standard: "1.4.3",
    copyright: "2026 Demo",
    contact: "https://gitlab.com/acme",
    codeowners: ["@acme/tools"],
    platform: "gitlab",
  });
  expect(config.platform).toBe("gitlab");
  expect(parseConfig(renderConfig(config)).platform).toBe("gitlab");
  expect(
    defaultConfig({ stacks: ["node"], standard: "1.4.3", copyright: "c", contact: "c", codeowners: [] }).platform,
  ).toBe("github");
});
