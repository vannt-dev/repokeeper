import { expect, it } from "vitest";
import { type Module, outputId } from "../src/model.js";
import { planOutputs } from "../src/plan.js";
import { makeContext } from "./helpers.js";

const paths = (ctx = makeContext()) => [...new Set(planOutputs(ctx).map((o) => o.path))].sort();

it("plans every core output for a node repository", () => {
  expect(paths()).toEqual([
    ".editorconfig",
    ".gitattributes",
    ".github/CODEOWNERS",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/dependabot.yml",
    ".github/pull_request_template.md",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".gitignore",
    ".release-please-manifest.json",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "SECURITY.md",
    "commitlint.config.mjs",
    "lefthook.yml",
    "package.json",
    "release-please-config.json",
  ]);
});

it("is sorted and deterministic", () => {
  const ids = planOutputs(makeContext()).map(outputId);
  expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  expect(planOutputs(makeContext())).toEqual(planOutputs(makeContext()));
});

it("drops disabled modules", () => {
  const ctx = makeContext({ modules: { hooks: false, deps: false, health: false } });
  expect(paths(ctx)).not.toContain("lefthook.yml");
  expect(paths(ctx)).not.toContain(".github/dependabot.yml");
  expect(paths(ctx)).not.toContain("LICENSE");
});

it("leaves owned paths alone, including Windows-style entries", () => {
  const ctx = makeContext({ config: { owned: ["LICENSE", ".github\\CODEOWNERS"] } });
  expect(paths(ctx)).not.toContain("LICENSE");
  expect(paths(ctx)).not.toContain(".github/CODEOWNERS");
});

it("leaves single owned keys and blocks alone, and everything under an owned key", () => {
  const ids = (owned: string[]) => planOutputs(makeContext({ config: { owned } })).map(outputId);
  const ci = ".github/workflows/ci.yml";
  const all = ids([]);
  expect(all).toContain(`yaml:${ci}#["on"]`);

  const onOwned = ids([`${ci}#on`]);
  expect(onOwned).not.toContain(`yaml:${ci}#["on"]`);
  expect(onOwned).toContain(`yaml:${ci}#["name"]`);

  const jobsOwned = ids([`${ci}#jobs`]);
  expect(jobsOwned.filter((id) => id.startsWith(`yaml:${ci}#["jobs"`))).toEqual([]);
  expect(jobsOwned).toContain(`yaml:${ci}#["permissions"]`);

  expect(ids(["package.json#devDependencies.lefthook"])).not.toContain(
    'json:package.json#["devDependencies","lefthook"]',
  );
  expect(ids([".gitattributes#editorconfig"])).not.toContain("block:.gitattributes#editorconfig");
  expect(ids([`${ci}#o`])).toContain(`yaml:${ci}#["on"]`);
});

it("refuses two modules producing the same output", () => {
  const twin: Module = {
    id: "twin",
    enabled: () => true,
    outputs: () => [{ kind: "file", module: "twin", path: "a.txt", content: "a" }],
  };
  expect(() => planOutputs(makeContext(), [twin, twin])).toThrow("file:a.txt");
});
