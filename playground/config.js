/**
 * What the playground knows about repokeeper, and how it turns the form into a `.repokeeper.yml`
 * and a command. No DOM in here: test/playground.test.ts runs these functions against the real
 * implementation in src/, so a list or a generated file that falls behind fails CI.
 */

/** The standard the generated file names; the test holds it to STANDARD_VERSION. */
export const STANDARD = "1.4.3";

/** The first repokeeper with presets, stacks in folders, workflow pinning and `init` from a written file. */
export const NEEDS_VERSION = "0.6.0";

export const STACKS = [
  { id: "node", label: "Node.js" },
  { id: "python", label: "Python" },
  { id: "dart", label: "Dart / Flutter" },
  { id: "script", label: "Shell / PowerShell" },
  { id: "java", label: "Java" },
  { id: "dotnet", label: ".NET" },
  { id: "go", label: "Go" },
  { id: "rust", label: "Rust" },
  { id: "kotlin", label: "Kotlin" },
  { id: "php", label: "PHP" },
  { id: "ruby", label: "Ruby" },
];

/** Stacks each platform has CI and releases for. */
export const PLATFORM_STACKS = {
  github: STACKS.map((stack) => stack.id),
  gitlab: ["node", "go"],
};

export const PRESETS = [
  { id: "essential", summary: "editor settings, .gitignore and CI only" },
  { id: "standard", summary: "everything except the drift check (the default)" },
  { id: "strict", summary: "everything, the drift check, and branch protection with a required review" },
];

/** In the order `init --interactive` asks about them. */
export const MODULES = [
  { id: "editorconfig", label: "Editor settings", hint: ".editorconfig, .gitattributes" },
  { id: "gitignore", label: ".gitignore", hint: "the stack's ignore rules" },
  { id: "commits", label: "Conventional Commits", hint: "commitlint, and a check on pull requests" },
  { id: "hooks", label: "Git hooks", hint: "lefthook: format staged files, lint the commit message" },
  { id: "ci", label: "CI", hint: "a workflow that tests the stack on every pull request" },
  {
    id: "release",
    label: "Releases",
    hint: "release-please: a release PR with the changelog (semantic-release on GitLab)",
  },
  { id: "deps", label: "Dependency updates", hint: "Dependabot (Renovate on GitLab)" },
  { id: "health", label: "Community files", hint: "LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CODEOWNERS" },
  { id: "drift", label: "Drift check", hint: "a CI job that fails when a managed file was edited by hand" },
];

/** What stands in for a detail the form was left empty on; `problems` reports each one still in use. */
export const PLACEHOLDERS = {
  copyright: `${new Date().getFullYear()} Your Name`,
  contact: "https://github.com/your-name",
  codeowners: "@your-name",
};

const ESSENTIAL_OFF = ["commits", "hooks", "release", "deps", "health", "drift"];

/** The module switches of a preset, `health` as a plain on or off. */
export function presetModules(preset) {
  const modules = Object.fromEntries(MODULES.map((module) => [module.id, module.id !== "drift"]));
  if (preset === "essential") for (const id of ESSENTIAL_OFF) modules[id] = false;
  if (preset === "strict") modules.drift = true;
  return modules;
}

/** A form filled in as `repokeeper init --preset <preset>` would decide. */
export function presetInput(preset, platform = "github") {
  const strict = preset === "strict" && platform === "github";
  return {
    platform,
    stacks: [{ id: "node", directory: "" }],
    modules: presetModules(preset),
    health: { license: true, copyright: "", contact: "", codeowners: "" },
    defaultBranch: "main",
    workflows: { mode: "default", ref: "", source: "" },
    protect: { enabled: strict, approvals: 1 },
    security: strict,
  };
}

const cleanFolder = (folder) => folder.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/** The stacks of the form in repokeeper's own order, each with its folder ("" at the root). */
function chosenStacks(input) {
  const allowed = PLATFORM_STACKS[input.platform];
  return STACKS.filter((stack) => allowed.includes(stack.id))
    .map((stack) => ({ id: stack.id, chosen: input.stacks.find((entry) => entry.id === stack.id) }))
    .filter((stack) => stack.chosen !== undefined)
    .map((stack) => {
      const directory = input.platform === "github" ? cleanFolder(stack.chosen.directory ?? "") : "";
      return { id: stack.id, directory: directory === "." ? "" : directory };
    });
}

const splitOwners = (text) => text.split(/[\s,]+/).filter((owner) => owner !== "");

function workflowSource(workflows) {
  if (workflows.mode === "exact") return { ref: "exact" };
  if (workflows.mode === "ref") return { ref: workflows.ref.trim() };
  if (workflows.mode === "mirror") {
    const ref = workflows.ref.trim();
    return { source: workflows.source.trim(), ...(ref === "" ? {} : { ref }) };
  }
  if (workflows.mode === "local") return { source: "local" };
  return undefined;
}

/** The configuration the form describes, with its keys in the order `init` writes them. */
export function buildConfig(input) {
  const stacks = chosenStacks(input);
  const { modules } = input;
  const health = input.health;
  const owners = splitOwners(health.codeowners);
  const config = {
    schema: 1,
    standard: STANDARD,
    platform: input.platform,
    stacks: stacks.map((stack) => stack.id),
    modules: {
      editorconfig: modules.editorconfig,
      commits: modules.commits,
      hooks: modules.hooks,
      ci: modules.ci,
      release: modules.release,
      deps: modules.deps,
      gitignore: modules.gitignore,
      drift: modules.drift,
      health: modules.health
        ? {
            license: health.license ? "MIT" : false,
            copyright: health.copyright.trim() || PLACEHOLDERS.copyright,
            contact: health.contact.trim() || PLACEHOLDERS.contact,
            codeowners: owners.length > 0 ? owners : [PLACEHOLDERS.codeowners],
          }
        : false,
    },
    owned: [],
    stack_options: Object.fromEntries(
      stacks.filter((stack) => stack.directory !== "").map((stack) => [stack.id, { directory: stack.directory }]),
    ),
  };

  const branch = input.defaultBranch.trim();
  const settings = branch !== "" && branch !== "main" ? { default_branch: branch } : {};
  if (input.platform === "github") {
    const workflows = workflowSource(input.workflows);
    if (workflows !== undefined) settings.workflows = workflows;
    if (input.security) settings.security = { dependabot_alerts: true, dependabot_security_updates: true };
    if (input.protect.enabled) {
      settings.protect = {
        require_pull_request: true,
        required_approvals: Number(input.protect.approvals),
        allow_force_push: false,
        ...(modules.commits ? { required_checks: ["commits / commitlint"] } : {}),
      };
    }
  }
  if (Object.keys(settings).length > 0) config[input.platform] = settings;
  return config;
}

/** What has to change before the file is worth saving; an empty list means repokeeper accepts it. */
export function problems(input) {
  const found = [];
  const stacks = chosenStacks(input);
  if (stacks.length === 0) found.push("Choose at least one stack.");
  for (const stack of stacks) {
    if (/^\/|(^|\/)\.\.(\/|$)/.test(stack.directory)) {
      found.push(`The folder of ${stack.id} has to be a path inside the repository.`);
    }
  }
  if (input.modules.health) {
    const { health } = input;
    if (health.copyright.trim() === "") found.push("Copyright line: still the placeholder.");
    if (health.contact.trim() === "") found.push("Contact: still the placeholder.");
    const owners = splitOwners(health.codeowners);
    if (owners.length === 0) found.push("Code owners: still the placeholder.");
    if (owners.some((owner) => !owner.startsWith("@"))) found.push("Code owners each start with @.");
  }
  if (input.platform === "github") {
    const { mode, ref, source } = input.workflows;
    if ((mode === "ref" || (mode === "mirror" && ref.trim() !== "")) && !/^[A-Za-z0-9_./-]+$/.test(ref.trim())) {
      found.push("Workflow ref: a tag, a branch or a commit SHA.");
    }
    if (mode === "mirror" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.trim())) {
      found.push("Workflow repository: write it as owner/name.");
    }
    const approvals = Number(input.protect.approvals);
    if (input.protect.enabled && !(Number.isInteger(approvals) && approvals >= 0 && approvals <= 10)) {
      found.push("Required approvals: a whole number from 0 to 10.");
    }
  }
  return found;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The preset whose `init` would decide what the form says, or null when the form goes further. */
export function matchingPreset(input) {
  if (input.workflows.mode !== "default" && input.platform === "github") return null;
  for (const { id } of PRESETS) {
    const preset = presetInput(id, input.platform);
    const github =
      input.platform !== "github" ||
      (input.security === preset.security &&
        input.protect.enabled === preset.protect.enabled &&
        (!input.protect.enabled || Number(input.protect.approvals) === preset.protect.approvals));
    if (github && same(input.modules, preset.modules) && (!input.modules.health || input.health.license)) return id;
  }
  return null;
}

/**
 * The `init` command that needs no file, when a preset says everything the form says. repokeeper then
 * reads the licence holder, the contact, the code owners and the default branch from git.
 */
export function shortcutCommand(input) {
  const preset = matchingPreset(input);
  const stacks = chosenStacks(input);
  if (preset === null || stacks.length === 0) return null;
  const args = ["npx", "repokeeper", "init"];
  if (preset !== "standard") args.push("--preset", preset);
  for (const stack of stacks) {
    args.push("--stack", stack.directory === "" ? stack.id : `${stack.id}:${stack.directory}`);
  }
  if (input.platform === "gitlab") args.push("--platform", "gitlab");
  return args.join(" ");
}

/** The commands to run once the file is saved as `.repokeeper.yml` at the root of the repository. */
export function fileCommands(input) {
  const config = buildConfig(input);
  const commands = ["npx repokeeper init"];
  if (config.github?.protect || config.github?.security) commands.push("npx repokeeper github apply");
  return commands;
}

const RESERVED = /^(~|null|true|false|yes|no|on|off|y|n)$/i;
const NUMBER = /^([-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?|0o[0-7]+|0x[0-9a-fA-F]+|[-+]?\.inf|\.nan)$/i;

function scalar(value) {
  if (typeof value !== "string") return String(value);
  const plain =
    /^[A-Za-z0-9_/.(][^\n\r\t"\\]*$/.test(value) &&
    !/\s$/.test(value) &&
    !/: | #|:$/.test(value) &&
    !RESERVED.test(value) &&
    !NUMBER.test(value);
  // JSON's string syntax is YAML's double-quoted one
  return plain ? value : JSON.stringify(value);
}

function lines(value, indent) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) return value.map((item) => `${pad}- ${scalar(item)}`);
  return Object.entries(value).flatMap(([key, item]) => {
    if (Array.isArray(item))
      return item.length === 0 ? [`${pad}${key}: []`] : [`${pad}${key}:`, ...lines(item, indent + 2)];
    if (item !== null && typeof item === "object") {
      return Object.keys(item).length === 0 ? [`${pad}${key}: {}`] : [`${pad}${key}:`, ...lines(item, indent + 2)];
    }
    return [`${pad}${key}: ${scalar(item)}`];
  });
}

/** The file as `init` writes it: the same first line, the same layout. */
export function renderConfig(config) {
  return `# repokeeper configuration: https://github.com/vannt-dev/repokeeper\n${lines(config, 0).join("\n")}\n`;
}
