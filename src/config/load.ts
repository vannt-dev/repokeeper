import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import { type Document, isNode, LineCounter, parseDocument, stringify } from "yaml";
import { ConfigError } from "../errors.js";
import { configSchema } from "./schema.js";
import type { ModulesConfig, RepokeeperConfig } from "./types.js";

export const CONFIG_FILE = ".repokeeper.yml";

const validate = new Ajv({ allErrors: false }).compile(configSchema);

export async function loadConfig(root: string): Promise<RepokeeperConfig> {
  let text: string;
  try {
    text = await readFile(join(root, CONFIG_FILE), "utf8");
  } catch {
    throw new ConfigError(`${CONFIG_FILE} not found; run \`repokeeper init\` first`);
  }
  return parseConfig(text);
}

export function parseConfig(text: string): RepokeeperConfig {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  const syntax = doc.errors[0];
  if (syntax) {
    const line = syntax.linePos?.[0]?.line ?? 1;
    throw new ConfigError(`${CONFIG_FILE}:${line}: ${syntax.message.split("\n")[0]}`);
  }
  const data: unknown = doc.toJS() ?? {};
  if (!validate(data)) {
    const error = validate.errors?.[0] as ErrorObject;
    const path = pathOf(error);
    throw new ConfigError(`${CONFIG_FILE}:${lineOf(doc, lineCounter, path)}: ${describe(error, path)}`);
  }
  const typed = data as Partial<RepokeeperConfig> &
    Pick<RepokeeperConfig, "schema" | "standard" | "platform" | "stacks">;
  const other = typed.platform === "gitlab" ? "github" : "gitlab";
  if (typed[other] !== undefined) {
    throw new ConfigError(
      `${CONFIG_FILE}:${lineOf(doc, lineCounter, [other])}: ${other} is not used on the ${typed.platform} platform`,
    );
  }
  const skipped = typed.github?.ci?.skip_when_only;
  const protect = typed.github?.protect;
  if (skipped && protect) {
    // a skipped job that calls a reusable workflow reports only its own name, never the checks inside it
    const gated = protect.required_checks?.find((check) =>
      typed.stacks.some((stack) => check === stack || check.startsWith(`${stack} / `)),
    );
    if (gated) {
      throw new ConfigError(
        `${CONFIG_FILE}:${lineOf(doc, lineCounter, ["github", "protect", "required_checks"])}: required_checks names ` +
          `"${gated}", a stack job that github.ci.skip_when_only skips on docs-only pull requests; ` +
          "such a pull request would wait for it forever",
      );
    }
  }
  return withDefaults(typed);
}

export function renderConfig(config: RepokeeperConfig): string {
  // written only when on: a file without the line is one every earlier repokeeper reads as well
  const { autoupdate, security, ...modules } = config.modules;
  const asked = { ...(autoupdate ? { autoupdate } : {}), ...(security ? { security } : {}) };
  const written = {
    ...config,
    modules: Object.keys(asked).length > 0 ? orderedModules({ ...modules, ...asked }) : modules,
  };
  return `# repokeeper configuration: https://github.com/vannt-dev/repokeeper\n${stringify(written)}`;
}

/** The module switches with `health`, the one that is a block, last. */
function orderedModules<T extends Pick<ModulesConfig, "health">>(modules: T): T {
  const { health, ...flags } = modules;
  return { ...flags, health } as T;
}

/** Rewrites `standard:` in place, keeping every comment and the rest of the layout. */
export function setStandard(text: string, version: string): string {
  const doc = parseDocument(text);
  doc.set("standard", version);
  return doc.toString();
}

function withDefaults(
  data: Partial<RepokeeperConfig> & Pick<RepokeeperConfig, "schema" | "standard" | "platform" | "stacks">,
): RepokeeperConfig {
  const modules = (data.modules ?? {}) as Partial<ModulesConfig>;
  if (modules.health === undefined) {
    throw new ConfigError(
      `${CONFIG_FILE}: modules.health is required; set it to false to leave community health files alone`,
    );
  }
  const config: RepokeeperConfig = {
    schema: data.schema,
    standard: data.standard,
    platform: data.platform,
    stacks: data.stacks,
    modules: {
      editorconfig: modules.editorconfig ?? true,
      commits: modules.commits ?? true,
      hooks: modules.hooks ?? true,
      ci: modules.ci ?? true,
      release: modules.release ?? true,
      deps: modules.deps ?? true,
      gitignore: modules.gitignore ?? true,
      drift: modules.drift ?? false,
      autoupdate: modules.autoupdate ?? false,
      security: modules.security ?? false,
      health: modules.health,
    },
    owned: data.owned ?? [],
    stack_options: data.stack_options ?? {},
  };
  if (data.github !== undefined) config.github = data.github;
  if (data.gitlab !== undefined) config.gitlab = data.gitlab;
  return config;
}

function pathOf(error: ErrorObject): (string | number)[] {
  const segments: (string | number)[] = error.instancePath
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  if (error.keyword === "additionalProperties") {
    segments.push((error.params as { additionalProperty: string }).additionalProperty);
  }
  return segments;
}

function describe(error: ErrorObject, path: (string | number)[]): string {
  const name = path.length > 0 ? path.join(".") : "(root)";
  if (error.keyword === "additionalProperties") return `${name} is not a known key`;
  if (error.keyword === "enum") {
    const allowed = (error.params as { allowedValues: unknown[] }).allowedValues;
    return `${name} must be one of: ${allowed.join(", ")}`;
  }
  return `${name} ${error.message ?? "is invalid"}`;
}

function lineOf(doc: Document, lineCounter: LineCounter, path: (string | number)[]): number {
  for (let length = path.length; length > 0; length--) {
    const node = doc.getIn(path.slice(0, length), true);
    if (isNode(node) && node.range) return lineCounter.linePos(node.range[0]).line;
  }
  return 1;
}
