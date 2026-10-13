import { describe, expect, it } from "vitest";
import { nextSteps, printWarnings } from "../src/commands/report.js";
import type { Output } from "../src/model.js";
import type { SyncResult } from "../src/sync/sync.js";
import { capture, gitlabContext, makeContext, tempDir } from "./helpers.js";

const workflow: Output = {
  kind: "yaml",
  module: "security",
  path: ".github/workflows/security.yml",
  keyPath: ["name"],
  value: "security",
};
const result = (...decisions: SyncResult["decisions"]): SyncResult => ({ decisions, removals: [] });
const on = { modules: { security: true } };

describe("what repokeeper says about code scanning", () => {
  it("says what a private repository needs, once: when the workflow is new", async () => {
    const created = await nextSteps(".", makeContext(on), result({ output: workflow, action: "create" }));
    expect(created).toEqual([
      "code scanning is free on a public repository; on a private one, turn on GitHub Code Security, or the security workflow fails when it uploads its results",
    ]);
    // a repository that has had the workflow for a while is not told again on every update
    expect(await nextSteps(".", makeContext(on), result({ output: workflow, action: "unchanged" }))).toEqual([]);
    expect(await nextSteps(".", makeContext(on), result({ output: workflow, action: "write" }))).toEqual([]);
  });

  it("stays quiet on GitHub when nothing was written", async () => {
    const noted = capture();
    await printWarnings(await tempDir(), makeContext(on), noted.io);
    expect(noted.out).toEqual([]);
  });

  it("says on GitLab that the switch writes nothing, and what does the work there", async () => {
    const noted = capture();
    await printWarnings(await tempDir(), gitlabContext(on), noted.io);
    expect(noted.out).toContain(
      "note: modules.security writes nothing on gitlab; include GitLab's SAST and Secret-Detection templates in .gitlab-ci.yml instead",
    );
    const quiet = capture();
    await printWarnings(await tempDir(), gitlabContext(), quiet.io);
    expect(quiet.out.join("\n")).not.toContain("modules.security");
  });
});
