import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { applyPreset } from "../src/commands/presets.js";
import { nextSteps, printWarnings } from "../src/commands/report.js";
import { parseConfig, renderConfig } from "../src/config/load.js";
import type { Output } from "../src/model.js";
import { MODULES } from "../src/modules/index.js";
import { publishModule } from "../src/modules/publish.js";
import { planOutputs } from "../src/plan.js";
import type { SyncResult } from "../src/sync/sync.js";
import { ACTION_PINS, TOOL_VERSIONS } from "../src/version.js";
import { capture, gitlabContext, makeContext, nodeResolved, tempDir } from "./helpers.js";

const PATH = ".github/workflows/release.yml";
const on = (overrides: Parameters<typeof makeContext>[0] = {}) =>
  makeContext({ ...overrides, modules: { publish: true, ...overrides.modules } });
const publishJob = (ctx = on()) => {
  const outputs = publishModule.outputs(ctx);
  expect(outputs).toHaveLength(1);
  const [output] = outputs as [Output];
  expect(output).toMatchObject({ kind: "yaml", module: "publish", path: PATH, keyPath: ["jobs", "publish"] });
  return (output as { value: Record<string, unknown> }).value;
};
const python = nodeResolved({
  id: "python",
  dependabot: ["pip"],
  ci: { workflow: "stack-python.yml", with: { "install-command": "python -m pip install -e ." } },
  release: { type: "python", version: "1.0.0" },
});
const COMMON = {
  needs: "release",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
  if: "${{ needs.release.outputs.release_created == 'true' }}",
  "runs-on": "ubuntu-latest",
  // trusted publishing: the registry takes the run's OIDC token instead of a stored one
  permissions: { contents: "read", "id-token": "write" },
};
const CHECKOUT = { uses: `actions/checkout@${ACTION_PINS.checkout.sha}`, with: { "persist-credentials": false } };
const notes = async (ctx: ReturnType<typeof makeContext>) => {
  const noted = capture();
  await printWarnings(await tempDir(), ctx, noted.io);
  return noted.out;
};
const dependabotIgnore = (ctx: ReturnType<typeof makeContext>) => {
  const file = planOutputs(ctx).find((output) => output.path === ".github/dependabot.yml");
  const config = parse(file?.kind === "file" ? file.content : "") as {
    updates: { "package-ecosystem": string; ignore?: { "dependency-name": string }[] }[];
  };
  return config.updates.find((update) => update["package-ecosystem"] === "github-actions")?.ignore;
};

describe("publish module", () => {
  it("is off unless asked for, in no preset, and round-trips through the configuration file", () => {
    expect(makeContext().config.modules.publish).toBe(false);
    expect(publishModule.enabled(makeContext().config)).toBe(false);
    expect(renderConfig(makeContext().config)).not.toContain("publish");
    for (const preset of ["essential", "standard", "strict"] as const) {
      expect(applyPreset(makeContext().config, preset).modules.publish).toBe(false);
    }
    expect(publishModule.enabled(on().config)).toBe(true);
    expect(parseConfig(renderConfig(on().config)).modules.publish).toBe(true);
    expect(MODULES).toContain(publishModule);
  });

  it("adds a publish job to the release workflow, next to the release job", () => {
    const outputs = planOutputs(on()).filter((output) => output.path === PATH && output.kind === "yaml");
    expect(outputs.map((output) => (output.kind === "yaml" ? output.keyPath.join(".") : ""))).toEqual(
      expect.arrayContaining(["jobs.release", "jobs.publish"]),
    );
  });

  it("publishes a node package to npm through trusted publishing, with no token", () => {
    expect(publishJob()).toEqual({
      ...COMMON,
      steps: [
        CHECKOUT,
        {
          uses: `actions/setup-node@${ACTION_PINS.setupNode.sha}`,
          with: { "node-version": "24", "registry-url": "https://registry.npmjs.org" },
        },
        { name: "Install dependencies", run: "npm ci" },
        // no --provenance: npm adds it by itself for a public repository, and refuses it for a private one
        { name: "Publish to npm", run: "npm publish --access public" },
      ],
    });
    expect(JSON.stringify(publishJob())).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
  });

  it("installs with the stack's package manager, and still publishes with npm", () => {
    const pnpm = nodeResolved();
    pnpm.ci = { workflow: "stack-node.yml", with: { "package-manager": "pnpm", "install-command": "pnpm install" } };
    const job = publishJob(on({ stacks: [pnpm] })) as { env: unknown; steps: { name?: string; run?: string }[] };
    expect(job.env).toEqual({ COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" });
    expect(job.steps.map((step) => step.run).filter(Boolean)).toEqual([
      "corepack enable",
      "pnpm install",
      "npm publish --access public",
    ]);
  });

  it("publishes a python package to PyPI through trusted publishing", () => {
    expect(publishJob(on({ config: { stacks: ["python"] }, stacks: [python] }))).toEqual({
      ...COMMON,
      steps: [
        CHECKOUT,
        { uses: `actions/setup-python@${ACTION_PINS.setupPython.sha}`, with: { "python-version": "3.x" } },
        { name: "Build", run: `python -m pip install build==${TOOL_VERSIONS.pypaBuild} && python -m build` },
        { name: "Publish to PyPI", uses: `pypa/gh-action-pypi-publish@${ACTION_PINS.pypiPublish.sha}` },
      ],
    });
  });

  it("publishes the stack that is released, and only that one", () => {
    const go = nodeResolved({ id: "go", release: { type: "go", version: null } });
    const job = publishJob(on({ config: { stacks: ["python", "go"] }, stacks: [python, go] })) as {
      steps: { name?: string }[];
    };
    expect(job.steps.at(-1)?.name).toBe("Publish to PyPI");
    // release-please releases go here, so there is no python release to publish
    expect(publishModule.outputs(on({ config: { stacks: ["go", "python"] }, stacks: [go, python] }))).toEqual([]);
  });

  it("writes nothing, and says why, where it cannot publish", async () => {
    const go = on({
      config: { stacks: ["go"] },
      stacks: [nodeResolved({ id: "go", release: { type: "go", version: null } })],
    });
    expect(publishModule.outputs(go)).toEqual([]);
    expect(await notes(go)).toContain(
      "note: modules.publish writes nothing: it publishes node packages to npm and python packages to PyPI, and go is neither",
    );

    const folder = on({ stacks: [nodeResolved({ directory: "web" })] });
    expect(publishModule.outputs(folder)).toEqual([]);
    expect(await notes(folder)).toContain(
      "note: modules.publish writes nothing: publishing a stack in a folder (web) is not supported",
    );

    const unreleased = on({ modules: { release: false } });
    expect(publishModule.outputs(unreleased)).toEqual([]);
    expect(await notes(unreleased)).toContain(
      "note: modules.publish writes nothing: it publishes what modules.release releases, which is off",
    );
    expect(await notes(on())).toEqual([]);
  });

  it("keeps Dependabot off the actions it writes into release.yml, which would show up as drift", () => {
    expect(dependabotIgnore(makeContext())).toBeUndefined();
    expect(dependabotIgnore(on())).toEqual([
      { "dependency-name": "actions/checkout" },
      { "dependency-name": "actions/setup-node" },
    ]);
    expect(dependabotIgnore(on({ config: { stacks: ["python"] }, stacks: [python] }))).toEqual([
      { "dependency-name": "actions/checkout" },
      { "dependency-name": "actions/setup-python" },
      { "dependency-name": "pypa/gh-action-pypi-publish" },
    ]);
    // nothing to leave alone where nothing is written
    expect(dependabotIgnore(on({ modules: { release: false } }))).toBeUndefined();
  });

  it("pins the actions it writes to the commits the reusable workflows here use", () => {
    const reusable =
      readFileSync(".github/workflows/stack-node.yml", "utf8") +
      readFileSync(".github/workflows/stack-python.yml", "utf8");
    for (const pin of [ACTION_PINS.checkout, ACTION_PINS.setupNode, ACTION_PINS.setupPython]) {
      expect(reusable).toContain(`${pin.action}@${pin.sha} # ${pin.version}`);
    }
    for (const pin of Object.values(ACTION_PINS)) expect(pin.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("names the trusted publisher to set up, once: when the job is new", async () => {
    const job: Output = { kind: "yaml", module: "publish", path: PATH, keyPath: ["jobs", "publish"], value: {} };
    const result = (action: string): SyncResult =>
      ({ decisions: [{ output: job, action }], removals: [] }) as unknown as SyncResult;
    expect(await nextSteps(".", on(), result("create"))).toEqual([
      "add a trusted publisher on npmjs.com (allow npm publish): repository vannt-dev/example, workflow release.yml, exactly; until then the publish job fails",
    ]);
    expect(await nextSteps(".", on({ config: { stacks: ["python"] }, stacks: [python] }), result("create"))).toEqual([
      "add a trusted publisher on pypi.org (environment left empty): repository vannt-dev/example, workflow release.yml, exactly; until then the publish job fails",
    ]);
    expect(await nextSteps(".", on(), result("unchanged"))).toEqual([]);
  });

  it("writes nothing on GitLab, and says so", async () => {
    const gitlab = gitlabContext({ modules: { publish: true } });
    expect(publishModule.outputs(gitlab)).toEqual([]);
    expect(await notes(gitlab)).toContain(
      "note: modules.publish writes nothing on gitlab; publishing is written for GitHub's release workflow only",
    );
  });
});
