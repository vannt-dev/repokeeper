import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { type Document, isNode, LineCounter, parseDocument } from "yaml";
import { ApiError, ConfigError } from "../errors.js";
import { type GitHubApi, resolveToken, restApi } from "../github/api.js";

/** How many files deep an `extends` chain may go, counted from the repository's own file. */
export const MAX_EXTENDS_DEPTH = 5;

/** Where a configuration file comes from: a file on disk, or a file in a GitHub repository at a ref. */
type Origin =
  | { kind: "local"; path: string }
  | { kind: "github"; owner: string; repo: string; path: string; ref: string | undefined };

/** One configuration file, read and parsed: the repository's own, or one it extends. */
export interface ConfigSource {
  /** How messages name the file: `.repokeeper.yml`, a path from the repository, or a `github:` source. */
  name: string;
  doc: Document;
  lineCounter: LineCounter;
  /** The file's content without its `extends` key. */
  data: unknown;
  /** The `extends` entries, as written. */
  extends: string[];
}

/** Parses one file; `name` is how errors refer to it. */
export function readSource(text: string, name: string): ConfigSource {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  const syntax = doc.errors[0];
  if (syntax) {
    const line = syntax.linePos?.[0]?.line ?? 1;
    throw new ConfigError(`${name}:${line}: ${syntax.message.split("\n")[0]}`);
  }
  const data: unknown = doc.toJS() ?? {};
  const source: ConfigSource = { name, doc, lineCounter, data, extends: [] };
  if (!isMapping(data) || !("extends" in data)) return source;
  const { extends: list, ...rest } = data;
  const entries = typeof list === "string" ? [list] : list;
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new ConfigError(
      `${at(source, ["extends"])}: extends must be a path or a github:owner/repo/path source, or a list of them`,
    );
  }
  return { ...source, data: rest, extends: entries.map((entry: string) => entry.trim()) };
}

/**
 * The files `repo` extends, depth first and each once, followed by `repo` itself: the order in which
 * they are merged, so that a later file overrides an earlier one.
 */
export async function resolveSources(root: string, repo: ConfigSource, api?: GitHubApi): Promise<ConfigSource[]> {
  const out: ConfigSource[] = [];
  const seen = new Set<string>();
  let client: Promise<GitHubApi> | undefined = api ? Promise.resolve(api) : undefined;
  const github = () => {
    client ??= defaultApi();
    return client;
  };

  async function visit(source: ConfigSource, origin: Origin, chain: { id: string; name: string }[]): Promise<void> {
    for (const entry of source.extends) {
      const where = at(source, ["extends"]);
      const target = originOf(entry, origin, where);
      const id = idOf(target);
      const name = nameOf(target, root);
      const loop = chain.findIndex((link) => link.id === id);
      if (loop >= 0) {
        const names = [...chain.slice(loop).map((link) => link.name), name];
        throw new ConfigError(`${where}: extends goes round in a circle: ${names.join(" -> ")}`);
      }
      // a file two others extend is merged once, where it is first reached
      if (seen.has(id)) continue;
      if (chain.length > MAX_EXTENDS_DEPTH) {
        const names = [...chain.map((link) => link.name), name];
        throw new ConfigError(
          `${where}: extends goes more than ${MAX_EXTENDS_DEPTH} files deep: ${names.join(" -> ")}`,
        );
      }
      seen.add(id);
      const base = readSource(await fetchText(target, where, name, github), name);
      if (!isMapping(base.data)) throw new ConfigError(`${name}:1: a file named by extends must be a mapping of keys`);
      if ("standard" in base.data) {
        throw new ConfigError(
          `${at(base, ["standard"])}: standard is not inherited; each repository names the standard it is on ` +
            "in its own .repokeeper.yml, where `repokeeper update` moves it",
        );
      }
      await visit(base, target, [...chain, { id, name }]);
      out.push(base);
    }
  }

  const self: Origin = { kind: "local", path: resolve(root, ".repokeeper.yml") };
  await visit(repo, self, [{ id: idOf(self), name: repo.name }]);
  return [...out, repo];
}

/** Mappings merge key by key; anything else, a list included, replaces what came before. */
export function mergeData(base: unknown, override: unknown): unknown {
  if (!isMapping(base) || !isMapping(override)) return override;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) merged[key] = mergeData(base[key], value);
  return merged;
}

/** `file:line` of the key at `path` in the merged result: the file its value was taken from. */
export function locate(sources: ConfigSource[], path: (string | number)[]): string {
  const repo = sources[sources.length - 1] as ConfigSource;
  let owner = repo;
  for (let length = 1; length <= path.length; length++) {
    const prefix = path.slice(0, length);
    const from = sources.findLast((source) => hasPath(source.data, prefix));
    if (from === undefined) break;
    owner = from;
    // past a list or a value, the whole of it came from that one file
    if (!isMapping(valueAt(from.data, prefix))) break;
  }
  return at(owner, path);
}

function at(source: ConfigSource, path: (string | number)[]): string {
  for (let length = path.length; length > 0; length--) {
    const node = source.doc.getIn(path.slice(0, length), true);
    if (isNode(node) && node.range) return `${source.name}:${source.lineCounter.linePos(node.range[0]).line}`;
  }
  return `${source.name}:1`;
}

function originOf(entry: string, from: Origin, where: string): Origin {
  if (entry.startsWith("github:")) {
    const match = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([^@]+?)(?:@([^@]+))?$/.exec(entry);
    const path = match?.[3] === undefined ? undefined : posix.normalize(match[3]);
    if (!match || path === undefined || path === "." || path.startsWith("../") || posix.isAbsolute(path)) {
      throw new ConfigError(`${where}: ${entry} is not a github:owner/repo/path/to/file.yml[@ref] source`);
    }
    return { kind: "github", owner: match[1] as string, repo: match[2] as string, path, ref: match[4] };
  }
  if (from.kind === "local") return { kind: "local", path: resolve(dirname(from.path), entry) };
  // a path in a file fetched from GitHub names another file of the same repository, at the same ref
  const path = posix.normalize(posix.join(posix.dirname(from.path), entry));
  if (isAbsolute(entry) || posix.isAbsolute(entry) || path === ".." || path.startsWith("../")) {
    throw new ConfigError(`${where}: ${entry} is outside ${from.owner}/${from.repo}; name it as a github: source`);
  }
  return { ...from, path };
}

function idOf(origin: Origin): string {
  if (origin.kind === "github") {
    return `github:${origin.owner}/${origin.repo}/${origin.path}${origin.ref ? `@${origin.ref}` : ""}`;
  }
  return process.platform === "win32" ? origin.path.toLowerCase() : origin.path;
}

function nameOf(origin: Origin, root: string): string {
  if (origin.kind === "github") return idOf(origin);
  const path = relative(root, origin.path);
  return isAbsolute(path) ? path : path.split(sep).join("/");
}

async function fetchText(
  origin: Origin,
  where: string,
  name: string,
  github: () => Promise<GitHubApi>,
): Promise<string> {
  const fail = (reason: string) => new ConfigError(`${where}: cannot read ${name}: ${reason}`);
  if (origin.kind === "local") {
    try {
      return await readFile(origin.path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw fail(code === "ENOENT" ? "no such file" : (error as Error).message);
    }
  }
  const path = origin.path.split("/").map(encodeURIComponent).join("/");
  const query = origin.ref ? `?ref=${encodeURIComponent(origin.ref)}` : "";
  let response: Awaited<ReturnType<GitHubApi["request"]>>;
  try {
    response = await (await github()).request("GET", `/repos/${origin.owner}/${origin.repo}/contents/${path}${query}`);
  } catch (error) {
    if (error instanceof ApiError) throw fail(`${error.message}; check the network connection`);
    throw error;
  }
  const { status, data } = response;
  const message = isMapping(data) && typeof data.message === "string" ? ` (${data.message})` : "";
  if (status === 404) {
    throw fail(
      "GitHub found no such repository, file or ref, or the token cannot read the repository; " +
        "in a workflow, GITHUB_TOKEN reads only the repository the workflow runs in",
    );
  }
  if (status === 401) throw fail(`GitHub refused the token${message}; check GITHUB_TOKEN or \`gh auth login\``);
  if (status === 403 || status === 429) {
    throw fail(`GitHub answered ${status}${message}; without a token the rate limit is low, so set GITHUB_TOKEN`);
  }
  if (status !== 200) throw fail(`GitHub answered ${status}${message}`);
  if (!isMapping(data) || data.type !== "file" || typeof data.content !== "string") {
    throw fail("it is not a file");
  }
  return Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8").toString("utf8");
}

/** A client with the token of the environment, or without one: a public repository is read either way. */
async function defaultApi(): Promise<GitHubApi> {
  try {
    return restApi(await resolveToken());
  } catch {
    return restApi(undefined);
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPath(data: unknown, path: (string | number)[]): boolean {
  let current = data;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === "number" && key < current.length) current = current[key];
    else if (isMapping(current) && Object.hasOwn(current, key)) current = current[key];
    else return false;
  }
  return true;
}

function valueAt(data: unknown, path: (string | number)[]): unknown {
  let current = data;
  for (const key of path) current = (current as Record<string | number, unknown>)[key];
  return current;
}
