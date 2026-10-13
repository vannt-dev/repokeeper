import { describe, expect, it } from "vitest";
import { parseConfig, renderConfig } from "../src/config/load.js";
import { STACK_IDS } from "../src/config/types.js";
import type { Output } from "../src/model.js";
import { MODULES } from "../src/modules/index.js";
import { securityModule } from "../src/modules/security.js";
import { planOutputs } from "../src/plan.js";
import { CODEQL_LANGUAGES } from "../src/platforms/github.js";
import { listWorkflows } from "../src/templates.js";
import { WORKFLOW_REF } from "../src/version.js";
import { gitlabContext, makeContext, nodeResolved } from "./helpers.js";

const PATH = ".github/workflows/security.yml";
const REUSABLE = ".github/workflows/codeql.yml";
const keys = (outputs: Output[]) =>
  Object.fromEntries(outputs.flatMap((o) => (o.kind === "yaml" ? [[o.keyPath.join("."), o.value]] : [])));
const on = (overrides: Parameters<typeof makeContext>[0] = {}) =>
  makeContext({ ...overrides, modules: { security: true, ...overrides.modules } });
/** What the workflow is told to analyze, for a repository of these stacks. */
const languages = (...ids: (typeof STACK_IDS)[number][]) => {
  const job = keys(securityModule.outputs(on({ stacks: ids.map((id) => nodeResolved({ id })) })))["jobs.codeql"] as {
    with: { languages: string };
  };
  return JSON.parse(job.with.languages) as { language: string; "build-mode": string }[];
};

describe("security module", () => {
  it("is off unless asked for, and round-trips through the configuration file", () => {
    expect(makeContext().config.modules.security).toBe(false);
    expect(securityModule.enabled(makeContext().config)).toBe(false);
    expect(planOutputs(makeContext()).some((output) => output.path === PATH)).toBe(false);

    expect(securityModule.enabled(on().config)).toBe(true);
    expect(parseConfig(renderConfig(on().config)).modules.security).toBe(true);
    expect(MODULES).toContain(securityModule);
  });

  it("writes a workflow that calls the reusable CodeQL workflow on pull requests, pushes and weekly", () => {
    const outputs = securityModule.outputs(on());
    // the caller only: the reusable workflow it calls stays in the repokeeper repository
    expect(new Set(outputs.map((output) => output.path))).toEqual(new Set([PATH]));
    expect(outputs.every((output) => output.module === "security")).toBe(true);

    const out = keys(outputs);
    expect(out.name).toBe("security");
    // weekly as well: new queries find things in code that has not changed
    expect(out.on).toEqual({
      pull_request: null,
      push: { branches: ["main"] },
      schedule: [{ cron: "41 4 * * 3" }],
    });
    expect(out.permissions).toEqual({ contents: "read" });
    expect(out.concurrency).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
      group: "${{ github.workflow }}-${{ github.ref }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
    expect(out["jobs.codeql"]).toEqual({
      uses: `vannt-dev/repokeeper/.github/workflows/codeql.yml@${WORKFLOW_REF}`,
      // what the called job asks for; a called workflow cannot have more than its caller grants
      permissions: { "security-events": "write", actions: "read", contents: "read" },
      with: {
        languages: JSON.stringify([
          { language: "javascript-typescript", "build-mode": "none" },
          { language: "actions", "build-mode": "none" },
        ]),
      },
    });
  });

  it("runs on the configured default branch", () => {
    const out = keys(securityModule.outputs(on({ config: { github: { default_branch: "develop" } } })));
    expect(out.on).toMatchObject({ push: { branches: ["develop"] } });
  });

  it("names each stack's language once, with a build only where CodeQL needs one", () => {
    expect(languages("python", "ruby", "rust", "dotnet")).toEqual([
      { language: "python", "build-mode": "none" },
      { language: "ruby", "build-mode": "none" },
      { language: "rust", "build-mode": "none" },
      { language: "csharp", "build-mode": "none" },
      { language: "actions", "build-mode": "none" },
    ]);
    // Go has no analysis without a build
    expect(languages("go")).toEqual([
      { language: "go", "build-mode": "autobuild" },
      { language: "actions", "build-mode": "none" },
    ]);
    // Java is read from source; Kotlin is not, and one database holds both
    expect(languages("java")[0]).toEqual({ language: "java-kotlin", "build-mode": "none" });
    expect(languages("kotlin")[0]).toEqual({ language: "java-kotlin", "build-mode": "autobuild" });
    expect(languages("java", "kotlin")).toEqual([
      { language: "java-kotlin", "build-mode": "autobuild" },
      { language: "actions", "build-mode": "none" },
    ]);
    expect(languages("node", "node")).toHaveLength(2);
  });

  it("still analyzes the workflows of a repository whose stacks CodeQL does not know", () => {
    expect(languages("dart", "php", "script", "docker")).toEqual([{ language: "actions", "build-mode": "none" }]);
  });

  it("has an answer for every stack", () => {
    // a new stack has to say what CodeQL calls it, or that CodeQL does not know it
    expect(Object.keys(CODEQL_LANGUAGES).sort()).toEqual([...STACK_IDS].sort());
  });

  it("follows where the reusable workflows are taken from", () => {
    const self = keys(securityModule.outputs(on({ repo: { owner: "vannt-dev", name: "repokeeper" } })));
    expect(self["jobs.codeql"]).toMatchObject({ uses: "./.github/workflows/codeql.yml" });

    const local = securityModule.outputs(on({ config: { github: { workflows: { source: "local" } } } }));
    // a repository that keeps its own copies gets one of this workflow too
    expect(local.some((output) => output.kind === "seed" && output.path === REUSABLE)).toBe(true);
    expect(keys(local)["jobs.codeql"]).toMatchObject({ uses: `./${REUSABLE}` });
    expect(listWorkflows()).toContain("codeql.yml");
  });

  it("writes nothing on GitLab", () => {
    expect(securityModule.outputs(gitlabContext({ modules: { security: true } }))).toEqual([]);
  });
});
