import { describe, expect, it } from "vitest";
import type { FileOutput } from "../src/model.js";
import { editorconfigModule } from "../src/modules/editorconfig.js";
import { healthModule } from "../src/modules/health.js";
import { hooksModule } from "../src/modules/hooks.js";
import { releaseModule } from "../src/modules/release.js";
import { TOOL_VERSIONS } from "../src/version.js";
import { makeContext, nodeResolved } from "./helpers.js";

const python = nodeResolved({
  id: "python",
  staged: [],
  test: "python -m pytest",
  install: "python -m pip install -e .",
  gitignore: ["Python"],
  dependabot: ["pip"],
  release: { type: "python", version: "0.1.0" },
});
const file = (outputs: ReturnType<typeof hooksModule.outputs>, path: string) =>
  outputs.find((o) => o.path === path) as FileOutput;

describe("repositories without a node stack", () => {
  it("run commitlint through npx pinned to the standard's versions", () => {
    const outputs = hooksModule.outputs(makeContext({ stacks: [python] }));
    expect(file(outputs, "lefthook.yml").content).toContain(
      `npx --yes --package @commitlint/cli@${TOOL_VERSIONS.commitlintCli} --package @commitlint/config-conventional@${TOOL_VERSIONS.commitlintConventional} -- commitlint --edit {1}`,
    );
    expect(outputs.some((o) => o.path === "package.json")).toBe(false);
  });

  it("tell contributors to install the hooks with a pinned lefthook", () => {
    const contributing = file(healthModule.outputs(makeContext({ stacks: [python] })), "CONTRIBUTING.md");
    expect(contributing.content).toContain("Run `python -m pip install -e .`.");
    expect(contributing.content).toContain(`\`npx --yes lefthook@${TOOL_VERSIONS.lefthook} install\``);
  });

  it("start the setup with the hook install when the stack has no install command", () => {
    const script = nodeResolved({ id: "script", staged: [], test: null, install: null, gitignore: [], dependabot: [] });
    const contributing = file(healthModule.outputs(makeContext({ stacks: [script] })), "CONTRIBUTING.md");
    expect(contributing.content).toContain(
      `## Local setup\n\nRun \`npx --yes lefthook@${TOOL_VERSIONS.lefthook} install\``,
    );
    expect(contributing.content).not.toContain("Then run");
  });

  it("name the configured default branch in the workflow", () => {
    const ctx = makeContext({ config: { github: { default_branch: "master" } } });
    expect(file(healthModule.outputs(ctx), "CONTRIBUTING.md").content).toContain("Create a branch from `master`.");
    expect(file(healthModule.outputs(makeContext()), "CONTRIBUTING.md").content).toContain(
      "Create a branch from `main`.",
    );
  });

  it("keep the node setup sentence for node repositories", () => {
    const contributing = file(healthModule.outputs(makeContext()), "CONTRIBUTING.md");
    expect(contributing.content).toContain("Installing the dependencies also installs the git hooks (lefthook).");
  });
});

describe("release extra files", () => {
  it("writes version-file for stacks that keep their version in a source file", () => {
    const release = { type: "ruby" as const, version: "1.2.0", versionFile: "lib/demo/version.rb" };
    const outputs = releaseModule.outputs(makeContext({ stacks: [nodeResolved({ release })] }));
    const pkg = JSON.parse(file(outputs, "release-please-config.json").content).packages["."];
    expect(pkg["release-type"]).toBe("ruby");
    expect(pkg["version-file"]).toBe("lib/demo/version.rb");
  });

  const xml = { type: "xml" as const, path: "Directory.Build.props", xpath: "//Project/PropertyGroup/Version" };
  const config = (extraFiles?: (typeof xml)[]) => {
    const release = { type: "simple" as const, version: "1.0.0", ...(extraFiles ? { extraFiles } : {}) };
    const outputs = releaseModule.outputs(makeContext({ stacks: [nodeResolved({ release })] }));
    return JSON.parse(file(outputs, "release-please-config.json").content).packages["."];
  };

  it("are passed to release-please", () => {
    expect(config([xml])["extra-files"]).toEqual([xml]);
  });

  it("are left out when a stack has none", () => {
    expect(config()).not.toHaveProperty("extra-files");
  });
});

describe("editorconfig", () => {
  it("keeps the 4-space convention of C#, F#, VB and Python", () => {
    const content = (editorconfigModule.outputs(makeContext())[0] as FileOutput).content;
    expect(content).toContain("[*.{cs,csx,vb,fs,fsx,fsi,py}]\nindent_size = 4\n");
  });
});

describe("maven releases", () => {
  const pkg = (type: "maven" | "simple") => {
    const outputs = releaseModule.outputs(
      makeContext({ stacks: [nodeResolved({ release: { type, version: "1.0.0" } })] }),
    );
    return JSON.parse(file(outputs, "release-please-config.json").content).packages["."];
  };

  it("skip the SNAPSHOT pull request, so a pom at 1.0.0 goes straight to its next release", () => {
    expect(pkg("maven")["skip-snapshot"]).toBe(true);
  });

  it("leave skip-snapshot out for other release types", () => {
    expect(pkg("simple")).not.toHaveProperty("skip-snapshot");
  });
});
