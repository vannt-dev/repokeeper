import type { RepokeeperConfig, StackId } from "./config/types.js";
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
}

export interface ResolvedStack {
  id: StackId;
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

export interface RepoInfo {
  owner: string | null;
  name: string;
  /** Version of the latest `vX.Y.Z` tag; seeds the release manifest when the stack has no version of its own. */
  releasedVersion?: string | null;
}

export interface PlatformAdapter {
  id: "github";
  communityFiles(ctx: ModuleContext): Output[];
  dependencyUpdates(ecosystems: string[]): Output[];
  /** The caller CI workflow; empty when no job would run. */
  ciWorkflow(ctx: ModuleContext): Output[];
  /** release-please configuration, its manifest and the caller release workflow. */
  releaseAutomation(ctx: ModuleContext, release: ReleaseInfo): Output[];
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
