import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseExtraFile, ReleaseInfo } from "../model.js";

/**
 * Writing a release's version into the files of a stack, for a release tool that has no updater per
 * language: on GitHub release-please does this, on GitLab the release job runs `repokeeper bump`.
 * Every function here takes the text of a file and returns it with the new version, or null when
 * the file holds no version of the kind it looks for.
 */

const SEMVER = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/;

/** Replaces the first match of `pattern` in the body of the `[name]` table; group 1 is what precedes the version. */
function inTomlTable(toml: string, name: string, pattern: RegExp, version: string): string | null {
  const header = new RegExp(`^\\[${name.replace(/\./g, "\\.")}\\][^\\n]*$`, "m").exec(toml);
  if (!header) return null;
  const start = header.index + header[0].length;
  const next = /^\[/m.exec(toml.slice(start));
  const end = next ? start + next.index : toml.length;
  const body = toml.slice(start, end);
  if (!pattern.test(body)) return null;
  return toml.slice(0, start) + body.replace(pattern, `$1${version}$2`) + toml.slice(end);
}

const TOML_VERSION = /^(version\s*=\s*")[^"]*(")/m;

/** `version` of `[project]`, or of `[tool.poetry]` for a Poetry project without one. */
export function bumpPyproject(text: string, version: string): string | null {
  return inTomlTable(text, "project", TOML_VERSION, version) ?? inTomlTable(text, "tool.poetry", TOML_VERSION, version);
}

/** `version = x` of `[metadata]` in setup.cfg. */
export function bumpSetupCfg(text: string, version: string): string | null {
  const header = /^\[metadata\][^\n]*$/m.exec(text);
  if (!header) return null;
  const start = header.index + header[0].length;
  const next = /^\[/m.exec(text.slice(start));
  const end = next ? start + next.index : text.length;
  const pattern = /^(version\s*=\s*)\S+/m;
  const body = text.slice(start, end);
  // `attr:` and `file:` read the version from elsewhere; there is nothing to write here
  if (!pattern.test(body) || /^version\s*=\s*(attr|file):/m.test(body)) return null;
  return text.slice(0, start) + body.replace(pattern, `$1${version}`) + text.slice(end);
}

/** The `version="x"` argument of `setup()` in setup.py. */
export function bumpSetupPy(text: string, version: string): string | null {
  const pattern = /(\bversion\s*=\s*["'])[^"']*(["'])/;
  return pattern.test(text) ? text.replace(pattern, `$1${version}$2`) : null;
}

/** `version:` of pubspec.yaml; a build number (`+4`) is kept and counted up, as stores require. */
export function bumpPubspec(text: string, version: string): string | null {
  const match = /^(version:\s*)(\S+)/m.exec(text);
  if (!match) return null;
  const build = /\+(\d+)$/.exec(match[2] as string);
  const next = build ? `${version}+${Number(build[1]) + 1}` : version;
  return text.replace(/^(version:\s*)\S+/m, `$1${next}`);
}

/** `version` of `[package]` in Cargo.toml, or of `[workspace.package]` when the package inherits it. */
export function bumpCargoToml(text: string, version: string): string | null {
  return (
    inTomlTable(text, "package", TOML_VERSION, version) ?? inTomlTable(text, "workspace.package", TOML_VERSION, version)
  );
}

/** The name of the crate at the root, for its entry in Cargo.lock. */
export function cargoPackageName(cargoToml: string): string | null {
  const table = cargoToml.split(/^\[/m).find((part) => part.startsWith("package]")) ?? "";
  return /^name\s*=\s*"([^"]+)"/m.exec(table)?.[1] ?? null;
}

/** The crate's own entry in Cargo.lock, which `cargo build --locked` compares with Cargo.toml. */
export function bumpCargoLock(text: string, name: string, version: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${escaped}"\\r?\\nversion = ")[^"]*(")`);
  return pattern.test(text) ? text.replace(pattern, `$1${version}$2`) : null;
}

/** The top-level `version` of composer.json, when the project keeps one; Composer itself reads tags. */
export function bumpComposer(text: string, version: string): string | null {
  let current: unknown;
  try {
    current = (JSON.parse(text) as { version?: unknown }).version;
  } catch {
    return null;
  }
  if (typeof current !== "string") return null;
  const pattern = new RegExp(`("version"\\s*:\\s*")${current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(")`);
  return pattern.test(text) ? text.replace(pattern, `$1${version}$2`) : null;
}

/** `VERSION = "x"` of a gem's version.rb. */
export function bumpRubyVersion(text: string, version: string): string | null {
  const pattern = /^(\s*VERSION\s*=\s*["'])[^"']*(["'])/m;
  return pattern.test(text) ? text.replace(pattern, `$1${version}$2`) : null;
}

/** The gem's own entry in Gemfile.lock: the spec of the `PATH` source that is the repository itself. */
export function bumpGemfileLock(text: string, version: string): string | null {
  const pattern = /(^PATH\r?\n {2}remote: \.\r?\n {2}specs:\r?\n {4}\S+ \()[^)]*(\))/m;
  return pattern.test(text) ? text.replace(pattern, `$1${version}$2`) : null;
}

interface Element {
  /** Names of the element and its ancestors, outermost first. */
  path: string[];
  /** Where its text starts and ends. */
  start: number;
  end: number;
}

/** The elements of an XML document in order, without reading comments, CDATA or processing instructions as tags. */
function* elements(xml: string): Generator<Element> {
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!\w[^>]*>|<(\/?)([\w.:-]+)([^>]*?)(\/?)>/g;
  const open: Array<{ name: string; start: number }> = [];
  for (let match = token.exec(xml); match !== null; match = token.exec(xml)) {
    const [, closing, name, , selfClosing] = match;
    if (name === undefined || selfClosing === "/") continue;
    if (closing === "/") {
      const element = open.pop();
      if (element === undefined) return;
      yield { path: [...open.map((e) => e.name), element.name], start: element.start, end: match.index };
    } else {
      open.push({ name, start: match.index + match[0].length });
    }
  }
}

/** Sets the text of the first element whose path ends with (or, when `anchored`, is exactly) `path`. */
function setElement(xml: string, path: string[], version: string, anchored: boolean): string | null {
  for (const element of elements(xml)) {
    const tail = anchored ? element.path : element.path.slice(-path.length);
    if (tail.length !== path.length || tail.some((name, index) => name !== path[index])) continue;
    return xml.slice(0, element.start) + version + xml.slice(element.end);
  }
  return null;
}

/** `<version>` of the project itself in pom.xml: not the parent's, a dependency's or a plugin's. */
export function bumpPom(text: string, version: string): string | null {
  return setElement(text, ["project", "version"], version, true);
}

/** An element named by a path such as `//Project/PropertyGroup/Version` (the form release-please takes). */
export function bumpXml(text: string, xpath: string, version: string): string | null {
  const anchored = !xpath.startsWith("//");
  const path = xpath.replace(/^\/+/, "").split("/");
  return path.every((name) => /^[\w.:-]+$/.test(name)) ? setElement(text, path, version, anchored) : null;
}

/**
 * release-please's generic updater: the version on a line marked `x-release-please-version`, and on
 * every line between `x-release-please-start-version` and `x-release-please-end`.
 */
export function bumpMarked(text: string, version: string): string | null {
  let inside = false;
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (line.includes("x-release-please-start-version")) {
      inside = true;
      return line;
    }
    if (line.includes("x-release-please-end")) {
      inside = false;
      return line;
    }
    if ((inside || line.includes("x-release-please-version")) && SEMVER.test(line)) {
      changed = true;
      return line.replace(SEMVER, version);
    }
    return line;
  });
  return changed ? lines.join("\n") : null;
}

type Edit = (text: string, read: (path: string) => Promise<string | null>) => Promise<string | null> | string | null;

/** The files that can hold the version of a release, with how each is rewritten. Paths are relative to the stack. */
function plan(release: ReleaseInfo, version: string): Array<{ path: string; edit: Edit }> {
  const own: Array<{ path: string; edit: Edit }> = [];
  if (release.type === "python") {
    own.push(
      { path: "pyproject.toml", edit: (text) => bumpPyproject(text, version) },
      { path: "setup.cfg", edit: (text) => bumpSetupCfg(text, version) },
      { path: "setup.py", edit: (text) => bumpSetupPy(text, version) },
    );
  } else if (release.type === "dart") {
    own.push({ path: "pubspec.yaml", edit: (text) => bumpPubspec(text, version) });
  } else if (release.type === "maven") {
    own.push({ path: "pom.xml", edit: (text) => bumpPom(text, version) });
  } else if (release.type === "rust") {
    own.push(
      { path: "Cargo.toml", edit: (text) => bumpCargoToml(text, version) },
      {
        path: "Cargo.lock",
        edit: async (text, read) => {
          const name = cargoPackageName((await read("Cargo.toml")) ?? "");
          return name ? bumpCargoLock(text, name, version) : null;
        },
      },
    );
  } else if (release.type === "php") {
    own.push({ path: "composer.json", edit: (text) => bumpComposer(text, version) });
  } else if (release.type === "ruby") {
    if (release.versionFile) own.push({ path: release.versionFile, edit: (text) => bumpRubyVersion(text, version) });
    own.push({ path: "Gemfile.lock", edit: (text) => bumpGemfileLock(text, version) });
  }
  const extra = (release.extraFiles ?? []).map((file: ReleaseExtraFile) =>
    typeof file === "string"
      ? { path: file, edit: (text: string) => bumpMarked(text, version) }
      : { path: file.path, edit: (text: string) => bumpXml(text, file.xpath, version) },
  );
  return [...own, ...extra];
}

/** Paths, relative to the stack, a release of this kind can change; for the release tool to commit. */
export function releaseFiles(release: ReleaseInfo): string[] {
  return [...new Set(plan(release, "0.0.0").map((file) => file.path))];
}

/**
 * Writes `version` into the stack's version files under `root` (the stack's own folder).
 * Returns the paths it changed (would change, when `write` is off); a file without a version is left as it is.
 */
export async function bumpVersion(
  root: string,
  release: ReleaseInfo,
  version: string,
  write = true,
): Promise<string[]> {
  const read = async (path: string) => {
    try {
      return await readFile(join(root, path), "utf8");
    } catch {
      return null;
    }
  };
  const changed: string[] = [];
  for (const { path, edit } of plan(release, version)) {
    const text = await read(path);
    if (text === null) continue;
    const next = await edit(text, read);
    if (next === null || next === text) continue;
    if (write) await writeFile(join(root, path), next);
    changed.push(path);
  }
  return changed;
}
