import { parseAllDocuments } from "yaml";

/** The package ecosystems whose lockfiles `github status` reads to check GitHub's dependency graph. */
export type Ecosystem = "npm" | "nuget";

/** Every version of every package the lockfiles of a repository name, keyed by `ecosystem:name`. */
export type VersionIndex = Map<string, Set<string>>;

/** The lockfile names `github status` reads, and the ecosystem of each. */
export const LOCKFILES: Record<string, Ecosystem> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "npm",
  "packages.config": "nuget",
};

/** NuGet ids are case-insensitive and `1.17.0.0` is the same version as `1.17.0`. */
function normalize(ecosystem: Ecosystem, name: string, version: string): { name: string; version: string } {
  if (ecosystem === "npm") return { name, version };
  const [core = "", ...rest] = version.split(/(?=[-+])/);
  const parts = core.split(".");
  while (parts.length > 3 && parts.at(-1) === "0") parts.pop();
  while (parts.length < 3) parts.push("0");
  return { name: name.toLowerCase(), version: [parts.join("."), ...rest].join("").toLowerCase() };
}

export function indexKey(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem}:${normalize(ecosystem, name, "0").name}`;
}

function add(index: VersionIndex, ecosystem: Ecosystem, name: string, version: string): void {
  if (!name || !version) return;
  const normal = normalize(ecosystem, name, version);
  const key = `${ecosystem}:${normal.name}`;
  const versions = index.get(key) ?? new Set<string>();
  versions.add(normal.version);
  index.set(key, versions);
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;

/** package-lock.json and npm-shrinkwrap.json: the `packages` map of lockfile v2/v3, or v1's nested `dependencies`. */
function readNpmLock(text: string, index: VersionIndex): void {
  const lock: unknown = JSON.parse(text);
  if (!isObject(lock)) return;
  if (isObject(lock.packages)) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      const at = path.lastIndexOf("node_modules/");
      if (at < 0 || !isObject(entry) || entry.link === true || typeof entry.version !== "string") continue;
      const name = typeof entry.name === "string" ? entry.name : path.slice(at + "node_modules/".length);
      add(index, "npm", name, entry.version);
    }
    return;
  }
  const walk = (dependencies: unknown) => {
    if (!isObject(dependencies)) return;
    for (const [name, entry] of Object.entries(dependencies)) {
      if (!isObject(entry)) continue;
      if (typeof entry.version === "string") add(index, "npm", name, entry.version);
      walk(entry.dependencies);
    }
  };
  walk(lock.dependencies);
}

/**
 * pnpm-lock.yaml: the keys of `packages`. pnpm 11 may write a document of its own dependencies first. Lockfile v9 writes `name@1.2.3(peer@4.0.0)`, v6 the same with a
 * leading slash, v5 `/name/1.2.3_peer@4.0.0`; a scoped name has its own `@`.
 */
function readPnpmLock(text: string, index: VersionIndex): void {
  for (const document of parseAllDocuments(text)) {
    if (!("errors" in document)) continue;
    if (document.errors.length > 0) throw document.errors[0];
    readPnpmDocument(document.toJS(), index);
  }
}

function readPnpmDocument(lock: unknown, index: VersionIndex): void {
  if (!isObject(lock) || !isObject(lock.packages)) return;
  const legacy = Number.parseFloat(String(lock.lockfileVersion ?? "9")) < 6;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (isObject(entry) && typeof entry.name === "string" && typeof entry.version === "string") {
      add(index, "npm", entry.name, entry.version);
      continue;
    }
    const plain = key.replace(/^\//, "").replace(/\(.*$/, "");
    if (legacy) {
      const segments = plain.split("/");
      const scoped = plain.startsWith("@");
      const name = segments.slice(0, scoped ? 2 : 1).join("/");
      add(index, "npm", name, (segments[scoped ? 2 : 1] ?? "").replace(/_.*$/, ""));
      continue;
    }
    const at = plain.lastIndexOf("@");
    if (at > 0) add(index, "npm", plain.slice(0, at), plain.slice(at + 1));
  }
}

/** packages.config of a .NET Framework project: `<package id="x" version="1.0.0" />`. */
function readPackagesConfig(text: string, index: VersionIndex): void {
  for (const [element] of text.matchAll(/<package\s[^>]*>/g)) {
    const id = /\sid\s*=\s*"([^"]+)"/.exec(element)?.[1];
    const version = /\sversion\s*=\s*"([^"]+)"/.exec(element)?.[1];
    if (id && version) add(index, "nuget", id, version);
  }
}

/** Adds the packages of one lockfile, named by its path, to the index. Throws when the file does not parse. */
export function readLockfile(path: string, text: string, index: VersionIndex): void {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "pnpm-lock.yaml") readPnpmLock(text, index);
  else if (name === "packages.config") readPackagesConfig(text, index);
  else readNpmLock(text, index);
}

export interface GraphPackage {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

/** An exact version, not a range from package.json such as `^3.25.76` or `1.x`. */
const EXACT = /^\d[0-9A-Za-z.+-]*$/;

/** The npm and NuGet packages of a dependency graph SBOM (`GET /repos/{owner}/{repo}/dependency-graph/sbom`). */
export function sbomPackages(sbom: unknown): GraphPackage[] {
  const packages = isObject(sbom) && isObject(sbom.sbom) ? sbom.sbom.packages : undefined;
  if (!Array.isArray(packages)) return [];
  const seen = new Set<string>();
  const result: GraphPackage[] = [];
  for (const entry of packages) {
    if (!isObject(entry) || !Array.isArray(entry.externalRefs)) continue;
    for (const ref of entry.externalRefs) {
      if (!isObject(ref) || ref.referenceType !== "purl" || typeof ref.referenceLocator !== "string") continue;
      const match = /^pkg:(npm|nuget)\/([^?#]+)@([^@?#]+)(?:[?#].*)?$/.exec(ref.referenceLocator);
      if (!match) continue;
      const ecosystem = match[1] as Ecosystem;
      let name: string;
      let version: string;
      try {
        name = decodeURIComponent(match[2] ?? "");
        version = decodeURIComponent(match[3] ?? "");
      } catch {
        continue;
      }
      if (!EXACT.test(version) || /(^|\.)[xX*](\.|$)/.test(version)) continue;
      const key = `${ecosystem}:${name}@${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ecosystem, name, version });
    }
  }
  return result;
}

export interface StalePackage extends GraphPackage {
  /** The versions the lockfiles name instead. */
  lockfile: string[];
}

/**
 * Packages the dependency graph names at a version no lockfile contains, while a lockfile has the package at
 * another version: GitHub has not re-read the manifest since it changed. A package no lockfile names at all
 * may come from a manifest this check does not read, so it is not reported.
 */
export function stalePackages(graph: GraphPackage[], index: VersionIndex): StalePackage[] {
  const stale: StalePackage[] = [];
  for (const pkg of graph) {
    const versions = index.get(indexKey(pkg.ecosystem, pkg.name));
    if (!versions || versions.size === 0) continue;
    if (versions.has(normalize(pkg.ecosystem, pkg.name, pkg.version).version)) continue;
    stale.push({ ...pkg, lockfile: [...versions].sort() });
  }
  return stale;
}
