import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConfig,
  fileCommands,
  MODULES,
  matchingPreset,
  PLACEHOLDERS,
  PLATFORM_STACKS,
  type PlaygroundInput,
  PRESETS,
  presetInput,
  problems,
  renderConfig,
  STACKS,
  STANDARD,
  shortcutCommand,
} from "../playground/config.js";
import { run } from "../src/cli.js";
import {
  applyPreset,
  MODULE_IDS,
  PRESET_SUMMARY,
  type Preset,
  PRESETS as REAL_PRESETS,
} from "../src/commands/presets.js";
import { parseConfig, renderConfig as realRenderConfig } from "../src/config/load.js";
import { defaultConfig, type PlatformId, STACK_IDS, type StackId } from "../src/config/types.js";
import { platformFor } from "../src/platforms/index.js";
import { STANDARD_VERSION } from "../src/version.js";
import { capture, tempDir } from "./helpers.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

/** The form of a preset, with the details `init` would read from git typed in. */
function filled(preset: string, platform: PlatformId = "github", stacks: PlaygroundInput["stacks"] = [{ id: "node" }]) {
  return {
    ...presetInput(preset, platform),
    stacks,
    health: {
      license: true,
      copyright: "2026 Demo User",
      contact: "https://github.com/demo-owner",
      codeowners: "@demo-owner",
    },
  };
}

/** What `init --preset` writes for the same repository. */
function initWrites(preset: Preset, platform: PlatformId, stacks: StackId[], directories: Record<string, string> = {}) {
  const defaults = defaultConfig({
    stacks,
    standard: STANDARD_VERSION,
    copyright: "2026 Demo User",
    contact: "https://github.com/demo-owner",
    codeowners: ["@demo-owner"],
    platform,
  });
  for (const [id, directory] of Object.entries(directories)) defaults.stack_options[id] = { directory };
  return applyPreset(defaults, preset);
}

async function nodeRepo(): Promise<string> {
  const dir = await tempDir();
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }, null, 2)}\n`,
  );
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.name", "Demo User");
  sh(dir, "config", "user.email", "demo@example.com");
  sh(dir, "config", "core.autocrlf", "false");
  sh(dir, "remote", "add", "origin", "https://github.com/demo-owner/demo.git");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "chore: initial");
  return dir;
}

describe("playground", () => {
  it("lists the stacks, presets, modules and standard that repokeeper has", () => {
    expect(STACKS.map((stack) => stack.id)).toEqual([...STACK_IDS]);
    expect(PLATFORM_STACKS.github).toEqual(platformFor("github").stacks);
    expect(PLATFORM_STACKS.gitlab).toEqual(platformFor("gitlab").stacks);
    expect(PRESETS).toEqual(REAL_PRESETS.map((id) => ({ id, summary: PRESET_SUMMARY[id] })));
    expect(MODULES.map((module) => module.id)).toEqual(MODULE_IDS);
    expect(STANDARD).toBe(STANDARD_VERSION);
  });

  for (const preset of REAL_PRESETS) {
    for (const platform of ["github", "gitlab"] as const) {
      it(`writes the file of init --preset ${preset} on ${platform}, character for character`, () => {
        const input = filled(preset, platform);
        expect(problems(input)).toEqual([]);
        expect(renderConfig(buildConfig(input))).toBe(realRenderConfig(initWrites(preset, platform, ["node"])));
        expect(matchingPreset(input)).toBe(preset);
      });
    }
  }

  it("writes stacks in folders and a default branch as init does", () => {
    const input = {
      ...filled("strict", "github", [
        { id: "go", directory: "./backend/" },
        { id: "node", directory: "frontend" },
      ]),
      defaultBranch: "trunk",
    };
    const expected = initWrites("strict", "github", ["node", "go"], { node: "frontend", go: "backend" });
    // init records the branch before the preset adds its settings
    expected.github = { default_branch: "trunk", ...expected.github };
    expect(renderConfig(buildConfig(input))).toBe(realRenderConfig(expected));
    expect(shortcutCommand(input)).toBe("npx repokeeper init --preset strict --stack node:frontend --stack go:backend");
    expect(fileCommands(input)).toEqual(["npx repokeeper init", "npx repokeeper github apply"]);
  });

  it("leaves out what GitLab has no support for: folders and the GitHub settings", () => {
    const input = {
      ...filled("strict", "gitlab", [
        { id: "python", directory: "backend" },
        { id: "go", directory: "tools" },
        { id: "node", directory: "web" },
      ]),
      defaultBranch: "trunk",
      workflows: { mode: "exact" as const, ref: "", source: "" },
      protect: { enabled: true, approvals: 2 },
      security: true,
    };
    expect(parseConfig(renderConfig(buildConfig(input)))).toEqual({
      ...initWrites("strict", "gitlab", ["node", "python", "go"]),
      gitlab: { default_branch: "trunk" },
    });
    expect(shortcutCommand(input)).toBe(
      "npx repokeeper init --preset strict --stack node --stack python --stack go --platform gitlab",
    );
    expect(fileCommands(input)).toEqual(["npx repokeeper init"]);
  });

  it("writes every way of naming the reusable workflows so that repokeeper reads it back", () => {
    const sources = [
      [{ mode: "exact", ref: "", source: "" }, { ref: "exact" }],
      [{ mode: "ref", ref: " 0123abc ", source: "" }, { ref: "0123abc" }],
      [{ mode: "mirror", ref: "", source: "acme/ci-workflows" }, { source: "acme/ci-workflows" }],
      [
        { mode: "mirror", ref: "v2", source: "acme/ci-workflows" },
        { source: "acme/ci-workflows", ref: "v2" },
      ],
      [{ mode: "local", ref: "", source: "" }, { source: "local" }],
    ] as const;
    for (const [workflows, expected] of sources) {
      const input = { ...filled("standard"), workflows: { ...workflows } };
      expect(problems(input)).toEqual([]);
      expect(parseConfig(renderConfig(buildConfig(input))).github).toEqual({ workflows: expected });
      // no init option says this, so only the file does
      expect(shortcutCommand(input)).toBeNull();
    }
  });

  it("quotes whatever YAML would read as something other than the text typed", () => {
    const awkward = [
      "2026 Demo User",
      "true",
      "No",
      "~",
      "1e3",
      "0x1F",
      "2026",
      "Müller & Søn: makers #1",
      "- dash",
      'say "hi"',
      "back\\slash",
      "trailing colon:",
      " padded ",
      "*star",
      "it's",
      "[not, a, list]",
    ];
    for (const text of awkward) {
      const input = {
        ...filled("standard"),
        health: { license: false, copyright: text, contact: text, codeowners: "@a, @org/team\n@b" },
      };
      const health = parseConfig(renderConfig(buildConfig(input))).modules.health;
      expect(health).toEqual({
        license: false,
        // the form trims what was typed
        copyright: text.trim(),
        contact: text.trim(),
        codeowners: ["@a", "@org/team", "@b"],
      });
    }
  });

  it("says what is still missing, and stands placeholders in for it", () => {
    const input = presetInput("standard");
    expect(problems(input)).toEqual([
      "Copyright line: still the placeholder.",
      "Contact: still the placeholder.",
      "Code owners: still the placeholder.",
    ]);
    // still a file repokeeper reads, so the preview is never a broken one
    expect(parseConfig(renderConfig(buildConfig(input))).modules.health).toEqual({
      license: "MIT",
      copyright: PLACEHOLDERS.copyright,
      contact: PLACEHOLDERS.contact,
      codeowners: [PLACEHOLDERS.codeowners],
    });
    expect(problems(presetInput("essential"))).toEqual([]);
    expect(problems({ ...filled("standard"), stacks: [] })).toEqual(["Choose at least one stack."]);
    expect(problems(filled("standard", "github", [{ id: "go", directory: "../elsewhere" }]))).toEqual([
      "The folder of go has to be a path inside the repository.",
    ]);
    const wrong = {
      ...filled("strict"),
      health: { license: true, copyright: "2026 Demo", contact: "demo@example.com", codeowners: "demo" },
      workflows: { mode: "mirror" as const, ref: "has space", source: "not-a-repository" },
      protect: { enabled: true, approvals: "11" },
    };
    expect(problems(wrong)).toEqual([
      "Code owners each start with @.",
      "Workflow ref: a tag, a branch or a commit SHA.",
      "Workflow repository: write it as owner/name.",
      "Required approvals: a whole number from 0 to 10.",
    ]);
  });

  it("offers the command only while a preset says everything the form says", () => {
    expect(shortcutCommand(filled("standard"))).toBe("npx repokeeper init --stack node");
    expect(shortcutCommand(filled("essential"))).toBe("npx repokeeper init --preset essential --stack node");
    const custom = filled("standard");
    custom.modules.release = false;
    expect(matchingPreset(custom)).toBeNull();
    expect(shortcutCommand(custom)).toBeNull();
    expect(shortcutCommand({ ...filled("strict"), protect: { enabled: true, approvals: 2 } })).toBeNull();
    expect(shortcutCommand({ ...filled("standard"), security: true })).toBeNull();
    const unlicensed = filled("standard");
    unlicensed.health.license = false;
    expect(shortcutCommand(unlicensed)).toBeNull();
  });

  it("gives a command that makes repokeeper write the file shown", async () => {
    for (const preset of REAL_PRESETS) {
      const dir = await nodeRepo();
      const input = filled(preset);
      const command = shortcutCommand(input);
      expect(command).not.toBeNull();
      const c = capture(dir);
      expect(await run((command as string).split(" ").slice(2), c.io)).toBe(0);
      expect(await readFile(join(dir, ".repokeeper.yml"), "utf8")).toBe(renderConfig(buildConfig(input)));
    }
  });

  it("gives a file that repokeeper init applies", async () => {
    const dir = await nodeRepo();
    const input = filled("strict");
    input.modules.release = false;
    input.workflows = { mode: "exact", ref: "", source: "" };
    const text = renderConfig(buildConfig(input));
    await writeFile(join(dir, ".repokeeper.yml"), text);
    const c = capture(dir);
    expect(await run(["init"], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("repokeeper github apply");
    expect(await readFile(join(dir, ".repokeeper.yml"), "utf8")).toBe(text);
    expect(await run(["check"], capture(dir).io)).toBe(0);
  });
});
