import { describe, expect, it } from "vitest";
import { parseConfig, renderConfig, setStandard } from "../src/config/load.js";
import { defaultConfig } from "../src/config/types.js";
import { ConfigError } from "../src/errors.js";

const base = defaultConfig({
  stacks: ["node"],
  standard: "1.0.0",
  copyright: "2026 Van Nguyen",
  contact: "https://github.com/vannt-dev",
  codeowners: ["@vannt-dev"],
});

function errorOf(text: string): string {
  try {
    parseConfig(text);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a ConfigError");
}

describe("parseConfig", () => {
  it("round-trips the rendered default config", () => {
    expect(parseConfig(renderConfig(base))).toEqual(base);
  });

  it("defaults boolean modules to true (drift, autoupdate, security, cache_cleanup and automerge to false) and optional lists to empty", () => {
    const config = parseConfig(
      "schema: 1\nstandard: 1.0.0\nplatform: github\nstacks: [node]\nmodules:\n  health: false\n",
    );
    expect(config.modules).toEqual({
      editorconfig: true,
      commits: true,
      hooks: true,
      ci: true,
      release: true,
      deps: true,
      gitignore: true,
      drift: false,
      autoupdate: false,
      security: false,
      cache_cleanup: false,
      automerge: false,
      health: false,
    });
    expect(config.owned).toEqual([]);
    expect(config.stack_options).toEqual({});
  });

  it("explains an empty file", () => {
    expect(errorOf("")).toMatch(/^\.repokeeper\.yml:1: \(root\) must have required property 'schema'/);
  });

  it("names the line and key of an unknown key", () => {
    const text =
      "schema: 1\nstandard: 1.0.0\nplatform: github\nstacks: [node]\nmodules:\n  health: false\n  hoks: true\n";
    expect(errorOf(text)).toBe(".repokeeper.yml:7: modules.hoks is not a known key");
  });

  it("refuses a required check on a stack job that docs-only pull requests skip", () => {
    const base = "schema: 1\nstandard: 1.0.0\nplatform: github\nstacks: [node]\nmodules:\n  health: false\n";
    const github =
      "github:\n  ci:\n    skip_when_only: ['*.md']\n  protect:\n    required_checks: ['node / test (22)']\n";
    expect(errorOf(base + github)).toMatch(/required_checks.*node \/ test \(22\).*skip_when_only/);
  });

  it("accepts skip_when_only next to required checks outside the stack jobs", () => {
    const base = "schema: 1\nstandard: 1.0.0\nplatform: github\nstacks: [node]\nmodules:\n  health: false\n";
    const github =
      "github:\n  ci:\n    skip_when_only: ['*.md', 'docs/**']\n  protect:\n    required_checks: ['commits / commitlint']\n";
    expect(parseConfig(base + github).github?.ci).toEqual({ skip_when_only: ["*.md", "docs/**"] });
  });

  it("checks the github section key by key", () => {
    const base = "schema: 1\nstandard: 1.0.0\nplatform: github\nstacks: [node]\nmodules:\n  health: false\n";
    expect(errorOf(`${base}github:\n  merge:\n    squosh: true\n`)).toBe(
      ".repokeeper.yml:9: github.merge.squosh is not a known key",
    );
    expect(errorOf(`${base}github:\n  topics: [CLI]\n`)).toMatch(/^\.repokeeper\.yml:8: github\.topics\.0 must match/);
  });

  it("lists the allowed values of an enum", () => {
    const text = "schema: 1\nstandard: 1.0.0\nplatform: github\nstacks: [cobol]\nmodules:\n  health: false\n";
    expect(errorOf(text)).toBe(
      ".repokeeper.yml:4: stacks.0 must be one of: node, python, dart, script, java, dotnet, go, rust, kotlin, php, ruby, docker",
    );
  });

  it("reports YAML syntax errors with their line", () => {
    expect(errorOf("schema: 1\nstacks: [node\n")).toMatch(/^\.repokeeper\.yml:\d+: /);
  });

  it("requires modules.health", () => {
    expect(errorOf("schema: 1\nstandard: 1.0.0\nplatform: github\nstacks: [node]\n")).toContain(
      "modules.health is required",
    );
  });
});

describe("setStandard", () => {
  it("changes only the standard and keeps comments", () => {
    const text = "# keep me\nschema: 1\nstandard: 1.0.0 # applied\nplatform: github\n";
    expect(setStandard(text, "1.1.0")).toBe("# keep me\nschema: 1\nstandard: 1.1.0 # applied\nplatform: github\n");
  });
});
