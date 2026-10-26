import { describe, expect, it } from "vitest";
import { nextSteps } from "../src/commands/report.js";
import type { Output } from "../src/model.js";
import type { SyncResult } from "../src/sync/sync.js";
import { TOOL_VERSIONS } from "../src/version.js";
import { makeContext, nodeResolved } from "./helpers.js";

const hooksFile: Output = { kind: "file", module: "hooks", path: "lefthook.yml", content: "" };
const lefthookRange = (path = "package.json"): Output => ({
  kind: "json",
  module: "hooks",
  path,
  keyPath: ["devDependencies", "lefthook"],
  value: `^${TOOL_VERSIONS.lefthook}`,
});

const result = (...decisions: SyncResult["decisions"]): SyncResult => ({ decisions, removals: [] });

describe("what to do after a write", () => {
  // A new standard can move a dependency's range and nothing else. The lockfile then names a version the range no
  // longer allows, and `npm ci` stops there.
  it("says to install again when only a range in package.json moved", async () => {
    const steps = await nextSteps(
      ".",
      makeContext(),
      result({ output: hooksFile, action: "unchanged" }, { output: lefthookRange(), action: "write" }),
    );
    expect(steps).toEqual(["package.json changed; install dependencies and commit the lockfile with it"]);
  });

  it("says it for a package.json in a folder too", async () => {
    const steps = await nextSteps(
      ".",
      makeContext(),
      result({ output: lefthookRange("web/package.json"), action: "write" }),
    );
    expect(steps).toEqual(["package.json changed; install dependencies and commit the lockfile with it"]);
  });

  it("says it once when the hooks are new: installing them is the same step", async () => {
    const steps = await nextSteps(
      ".",
      makeContext({ stacks: [nodeResolved({ staged: [] })] }),
      result({ output: hooksFile, action: "create" }, { output: lefthookRange(), action: "create" }),
    );
    expect(steps).toEqual(["install dependencies; this installs the git hooks"]);
  });

  it("says nothing when nothing in package.json was written", async () => {
    const steps = await nextSteps(
      ".",
      makeContext(),
      result({ output: hooksFile, action: "unchanged" }, { output: lefthookRange(), action: "unchanged" }),
    );
    expect(steps).toEqual([]);
  });
});

describe("telling a formatter to leave repokeeper's files alone", () => {
  const file = (path: string): Output => ({ kind: "file", module: "health", path, content: "" });
  const biome = nodeResolved({
    staged: [{ name: "node:biome", glob: "*.{js,json}", run: "npx biome check --write {staged_files}" }],
  });
  const created = result(
    { output: file("CODE_OF_CONDUCT.md"), action: "create" },
    { output: file("commitlint.config.mjs"), action: "create" },
    { output: file("LICENSE"), action: "create" },
    { output: file("SECURITY.md"), action: "unchanged" },
  );

  // Biome 2.6 formats Markdown and YAML too; a formatted copy no longer matches, and check reports it as edited.
  it("names the new files to exclude in biome.json", async () => {
    const steps = await nextSteps(".", makeContext({ stacks: [biome] }), created);
    expect(steps).toEqual([
      'Biome would reformat files repokeeper owns, and `repokeeper check` would then report them as edited; add "!CODE_OF_CONDUCT.md", "!commitlint.config.mjs", "!.repokeeper" to files.includes in biome.json',
    ]);
  });

  it("names them for .prettierignore with Prettier", async () => {
    const steps = await nextSteps(".", makeContext(), created);
    expect(steps).toEqual([
      "Prettier would reformat files repokeeper owns, and `repokeeper check` would then report them as edited; add CODE_OF_CONDUCT.md, commitlint.config.mjs, .repokeeper/ to .prettierignore",
    ]);
  });

  it("says nothing without a formatter, or when no such file is new", async () => {
    expect(await nextSteps(".", makeContext({ stacks: [nodeResolved({ staged: [] })] }), created)).toEqual([]);
    const unchanged = result({ output: file("CODE_OF_CONDUCT.md"), action: "unchanged" });
    expect(await nextSteps(".", makeContext({ stacks: [biome] }), unchanged)).toEqual([]);
  });
});
