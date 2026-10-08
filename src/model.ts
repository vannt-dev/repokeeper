import type { PlatformId, RepokeeperConfig, StackId } from "./config/types.js";
import type { CommentStyle } from "./sync/block.js";

export const MANAGED_HEADER =
  "Managed by repokeeper (https://github.com/vannt-dev/repokeeper). Edits are reported by `repokeeper check`.";

/** Header of YAML files repokeeper creates but owns only in part. */
export const YAML_HEADER = `${MANAGED_HEADER} Keys and jobs you add yourself are left alone.`;

export interface FileOutput {
  kind: "file";
  path: string;
  content: string;
  module: string;
}
/** A file repokeeper creates once and then leaves to other tools, such as a release manifest. */
export interface SeedOutput {
  kind: "seed";
  path: string;
  content: string;
  module: string;
}
export interface BlockOutput {
  kind: "block";
  path: string;
  id: string;
  body: string;
  comment: CommentStyle;
  module: string;
}
export interface JsonOutput {
  kind: "json";
  path: string;
  keyPath: string[];
  value: unknown;
  module: string;
}
/** Named keys of a YAML file, such as one job of a workflow. */
export interface YamlOutput {
  kind: "yaml";
  path: string;
  keyPath: string[];
  value: unknown;
  /** Preferred order of top-level keys, applied whenever repokeeper writes the file. */
  order?: readonly string[];
  module: string;
}
/** release-please version markers around one line of a file the user owns, such as gradle.properties' `version=`. */
export interface MarkerOutput {
  kind: "marker";
  path: string;
  /** Regular expression source of the line to wrap. */
  line: string;
  module: string;
}
export type Output = FileOutput | SeedOutput | BlockOutput | JsonOutput | YamlOutput | MarkerOutput;

export function outputId(output: Output): string {
  if (output.kind === "marker") return `marker:${output.path}`;
  if (output.kind === "file") return `file:${output.path}`;
  if (output.kind === "seed") return `seed:${output.path}`;
  if (output.kind === "block") return `block:${output.path}#${output.id}`;
  if (output.kind === "yaml") return `yaml:${output.path}#${JSON.stringify(output.keyPath)}`;
  return `json:${output.path}#${JSON.stringify(output.keyPath)}`;
}

export function describeOutput(output: Output): string {
  if (output.kind === "marker") return `${output.path} (release-please version markers)`;
  if (output.kind === "file" || output.kind === "seed") return output.path;
  if (output.kind === "block") return `${output.path} (block ${output.id})`;
  return `${output.path} (${output.keyPath.join(".")})`;
}

export interface StagedJob {
  name: string;
  glob: string;
  run: string;
}

/** One job of the caller CI workflow: a reusable workflow in the repokeeper repository and its inputs. */
export interface CiJob {
  workflow: string;
  with: Record<string, string>;
}

export type ReleaseType = "node" | "python" | "dart" | "maven" | "go" | "rust" | "php" | "ruby" | "simple";

/** A release-please `extra-files` entry: a path with release-please markers, or an XML element. */
export type ReleaseExtraFile = string | { type: "xml"; path: string; xpath: string };

export interface ReleaseInfo {
  type: ReleaseType;
  /** Current version read from the project, or null when it has none. */
  version: string | null;
  /** Files release-please updates besides the release type's own, such as Directory.Build.props. */
  extraFiles?: ReleaseExtraFile[];
  /** Source file holding the version, for release types that need one named (ruby's version.rb). */
  versionFile?: string;
  /** The line holding the version in a file release-please only updates between markers (gradle.properties). */
  versionLine?: { path: string; line: string };
}

export interface ResolvedStack {
  id: StackId;
  /** Folder the stack lives in, relative to the repository root with forward slashes; absent at the root. */
  directory?: string;
  /** lefthook pre-commit jobs; `{staged_files}` is filled in by lefthook. */
  staged: StagedJob[];
  /** Command for the pre-push test hook, or null when the repository has no tests. */
  test: string | null;
  /** Command that installs dependencies, quoted in CONTRIBUTING.md. */
  install: string | null;
  /** Template names under templates/gitignore/. */
  gitignore: string[];
  /** Dependabot package ecosystems. */
  dependabot: string[];
  /** CI job for this stack, or null when the stack has no reusable workflow. */
  ci: CiJob | null;
  release: ReleaseInfo;
}

/** A package ecosystem to keep up to date and the folder its manifest is in ("/" for the root). */
export interface DependencyUpdate {
  ecosystem: string;
  directory: string;
}

/** `command`, run from the stack's folder when it has one. */
export function inDirectory(stack: Pick<ResolvedStack, "directory">, command: string): string {
  return stack.directory ? `cd ${stack.directory} && ${command}` : command;
}

/** Whether the Node.js project is the repository itself, so its package.json can carry repokeeper's tools. */
export function nodeAtRoot(stacks: ResolvedStack[]): boolean {
  return stacks.some((stack) => stack.id === "node" && !stack.directory);
}

export interface RepoInfo {
  owner: string | null;
  name: string;
  /** Host of the origin remote; absent on GitHub, where it is always github.com. */
  host?: string | null;
  /** Version of the latest `vX.Y.Z` tag; seeds the release manifest when the stack has no version of its own. */
  releasedVersion?: string | null;
}

export interface PlatformAdapter {
  id: PlatformId;
  /** Stacks whose CI and release this platform can render. */
  stacks: readonly StackId[];
  /** What the platform calls a proposed change. */
  changeRequest: "pull request" | "merge request";
  /** Page of the repository's owner, or null when the remote is unknown. */
  profileUrl(repo: RepoInfo): string | null;
  /** How to report a vulnerability privately: the words after "Report the vulnerability privately ". */
  securityReport(repo: RepoInfo): string;
  communityFiles(ctx: ModuleContext): Output[];
  dependencyUpdates(updates: DependencyUpdate[]): Output[];
  /** The caller CI workflow; empty when no job would run. */
  ciWorkflow(ctx: ModuleContext): Output[];
  /** release-please configuration, its manifest and the caller release workflow. `directory` is the released stack's folder. */
  releaseAutomation(ctx: ModuleContext, release: ReleaseInfo, directory?: string): Output[];
}

export interface ModuleContext {
  config: RepokeeperConfig;
  stacks: ResolvedStack[];
  platform: PlatformAdapter;
  repo: RepoInfo;
}

export interface Module {
  id: string;
  enabled(config: RepokeeperConfig): boolean;
  outputs(ctx: ModuleContext): Output[];
}
