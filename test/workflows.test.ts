import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { dartStack } from "../src/stacks/dart.js";
import { dotnetStack } from "../src/stacks/dotnet.js";
import { goStack } from "../src/stacks/go.js";
import { javaStack } from "../src/stacks/java.js";
import { kotlinStack } from "../src/stacks/kotlin.js";
import { nodeStack } from "../src/stacks/node.js";
import { phpStack } from "../src/stacks/php.js";
import { pythonStack } from "../src/stacks/python.js";
import { rubyStack } from "../src/stacks/ruby.js";
import { rustStack } from "../src/stacks/rust.js";
import { scriptStack } from "../src/stacks/script.js";
import type { StackPack } from "../src/stacks/types.js";
import { TOOL_VERSIONS } from "../src/version.js";

interface Step {
  uses?: string;
  run?: string;
}
interface Job {
  permissions?: unknown;
  steps?: Step[];
  uses?: string;
  with?: Record<string, string>;
  needs?: string | string[];
  if?: string;
}
interface Workflow {
  on: { workflow_call?: { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> } };
  concurrency?: Record<string, string>;
  jobs: Record<string, Job>;
}

/** Reusable workflows hosted here. Each stack task appends its workflow. */
const REUSABLE = [
  "stack-node.yml",
  "commitlint.yml",
  "release-please.yml",
  "stack-script.yml",
  "stack-dart.yml",
  "stack-python.yml",
  "stack-java.yml",
  "stack-dotnet.yml",
  "repokeeper-check.yml",
  "stack-go.yml",
  "stack-rust.yml",
  "stack-php.yml",
  "stack-ruby.yml",
];

/** Fixture jobs in workflow-tests.yml and the pack that resolves each fixture. Each stack task appends its rows. */
const FIXTURES: { job: string; dir: string; pack: StackPack }[] = [
  { job: "node-npm", dir: "fixtures/node", pack: nodeStack },
  { job: "node-pnpm", dir: "fixtures/node-pnpm", pack: nodeStack },
  { job: "script", dir: "fixtures/script", pack: scriptStack },
  { job: "dart", dir: "fixtures/dart", pack: dartStack },
  { job: "python", dir: "fixtures/python", pack: pythonStack },
  { job: "java-maven", dir: "fixtures/java-maven", pack: javaStack },
  { job: "java-gradle", dir: "fixtures/java-gradle", pack: javaStack },
  { job: "dotnet", dir: "fixtures/dotnet", pack: dotnetStack },
  { job: "go", dir: "fixtures/go", pack: goStack },
  { job: "rust", dir: "fixtures/rust", pack: rustStack },
  { job: "kotlin", dir: "fixtures/kotlin", pack: kotlinStack },
  { job: "php", dir: "fixtures/php", pack: phpStack },
  { job: "ruby", dir: "fixtures/ruby", pack: rubyStack },
];

const read = (name: string) => readFileSync(`.github/workflows/${name}`, "utf8");
const workflow = (name: string) => parse(read(name)) as Workflow;
const steps = (wf: Workflow) => Object.values(wf.jobs).flatMap((job) => job.steps ?? []);
/** Inputs a fixture job may set differently from the pack: where it runs, and on which versions. */
const comparable = (inputs: Record<string, string> = {}) =>
  Object.fromEntries(
    Object.entries(inputs).filter(([key]) => key !== "working-directory" && key !== "os" && !key.endsWith("-versions")),
  );

describe.each(REUSABLE)("%s", (name) => {
  it("is a reusable workflow whose jobs all declare permissions", () => {
    const wf = workflow(name);
    expect(wf.on.workflow_call).toBeDefined();
    for (const job of Object.values(wf.jobs)) expect(job.permissions).toBeDefined();
  });

  it("pins every action by commit SHA", () => {
    const uses = steps(workflow(name)).flatMap((step) => (step.uses ? [step.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w.-]+)*@[0-9a-f]{40}$/);
  });

  it("keeps commands from reading the list they are looped over", () => {
    for (const step of steps(workflow(name))) {
      if (step.run?.includes("while IFS= read -r")) expect(step.run).toMatch(/<\/dev\/null\n/);
    }
  });
});

describe.each(FIXTURES)("fixture $dir", ({ job, dir, pack }) => {
  it("resolves to inputs its workflow accepts", async () => {
    const ci = (await pack.resolve(dir)).ci;
    expect(ci).not.toBeNull();
    const inputs = Object.keys(workflow(ci?.workflow ?? "").on.workflow_call?.inputs ?? {});
    expect(inputs).toEqual(expect.arrayContaining([...Object.keys(ci?.with ?? {}), "working-directory"]));
  });

  it("is exercised by workflow-tests with exactly what the pack resolves", async () => {
    const ci = (await pack.resolve(dir)).ci;
    const fixtureJob = workflow("workflow-tests.yml").jobs[job];
    expect(fixtureJob?.uses).toBe(`./.github/workflows/${ci?.workflow}`);
    expect(fixtureJob?.with?.["working-directory"]).toBe(dir);
    expect(comparable(fixtureJob?.with)).toEqual(comparable(ci?.with));
  });

  it("runs only when its fixture or workflow changed, or on the default branch", async () => {
    const tests = workflow("workflow-tests.yml");
    const fixtureJob = tests.jobs[job];
    expect(fixtureJob?.needs).toBe("changes");
    expect(fixtureJob?.if).toBe(
      `contains(needs.changes.outputs.run, ',all,') || contains(needs.changes.outputs.run, ',${job},')`,
    );
    const script = tests.jobs.changes?.steps?.map((s) => s.run ?? "").join("\n") ?? "";
    const ci = (await pack.resolve(dir)).ci;
    expect(script).toContain(`[${job}]="${dir}/ .github/workflows/${ci?.workflow}"`);
  });
});

it("workflow-tests cancels superseded pull request runs", () => {
  expect(workflow("workflow-tests.yml").concurrency).toEqual({
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
    group: "${{ github.workflow }}-${{ github.ref }}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
});

it("stack-node also accepts a custom test command", () => {
  expect(Object.keys(workflow("stack-node.yml").on.workflow_call?.inputs ?? {})).toContain("test-command");
});

it("commitlint uses the standard's tool versions and header rule", () => {
  const text = read("commitlint.yml");
  expect(text).toContain(`@commitlint/cli@${TOOL_VERSIONS.commitlintCli}`);
  expect(text).toContain(`@commitlint/config-conventional@${TOOL_VERSIONS.commitlintConventional}`);
  expect(text).toContain(`"header-max-length": [2, "always", 100]`);
});

it("release-please exposes the outputs callers use", () => {
  expect(Object.keys(workflow("release-please.yml").on.workflow_call?.outputs ?? {})).toEqual(
    expect.arrayContaining(["release_created", "tag_name", "version", "major"]),
  );
});
