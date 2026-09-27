import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Io } from "../cli.js";
import { duplicateTestRuns } from "../duplicates.js";
import { crlfTrackedFiles } from "../git.js";
import { describeOutput, type ModuleContext, type Output } from "../model.js";
import { overriddenAttributes } from "../sync/attributes.js";
import type { RemovalAction } from "../sync/decide.js";
import type { SyncResult } from "../sync/sync.js";
import { TOOL_VERSIONS } from "../version.js";

export interface CommandOptions {
  dryRun: boolean;
  force: boolean;
  adopt: string[];
  adoptAll: boolean;
  accept: string[];
  stacks: import("../config/types.js").StackId[];
  relock: boolean;
  json: boolean;
  yes: boolean;
}

/** How to name the output under `owned`: the path, or `path#key` for one key of a shared file. */
function ownedName(output: Output): string {
  if (output.kind === "yaml" || output.kind === "json") return `"${output.path}#${output.keyPath.join(".")}"`;
  if (output.kind === "block") return `"${output.path}#${output.id}"`;
  return "it";
}

const HINTS: Record<string, (output: Output) => string> = {
  conflict: (o) =>
    `edited locally; take repokeeper's version with --accept ${o.path}, or add ${ownedName(o)} to owned in .repokeeper.yml`,
  unmanaged: (o) =>
    `exists and is not managed; let repokeeper manage it with --adopt ${o.path}, or add ${ownedName(o)} to owned`,
};

const REMOVAL_NOTES: Partial<Record<RemovalAction, string>> = {
  "orphan-edited": " (no longer generated, but edited locally; left in place)",
  left: " (no longer generated; left for the tools that use it, delete it if none do)",
};

export function printResult(io: Io, result: SyncResult): void {
  let unchanged = 0;
  for (const { output, action } of result.decisions) {
    if (action === "unchanged") {
      unchanged++;
      continue;
    }
    const hint = HINTS[action]?.(output);
    io.out(`${action.padEnd(10)} ${describeOutput(output)}${hint ? ` (${hint})` : ""}`);
  }
  for (const { entry, action } of result.removals) {
    if (action === "gone" || action === "release") continue;
    const label = action === "orphan-edited" ? "kept" : action;
    const note = REMOVAL_NOTES[action] ?? "";
    io.out(`${label.padEnd(10)} ${entry.target.path}${note}`);
  }
  io.out(`${unchanged} output(s) already match the standard`);
}

const WROTE: string[] = ["create", "write", "adopt"];

/** What the user still has to do after a write: install the hooks, renormalize line endings. */
export async function nextSteps(root: string, ctx: ModuleContext, result: SyncResult): Promise<string[]> {
  const steps: string[] = [];
  const wrote = (path: string) => result.decisions.some((d) => d.output.path === path && WROTE.includes(d.action));
  if (ctx.config.modules.hooks && wrote("lefthook.yml")) {
    steps.push(
      ctx.stacks.some((s) => s.id === "node")
        ? "install dependencies; this installs the git hooks"
        : `run \`npx --yes lefthook@${TOOL_VERSIONS.lefthook} install\` to enable the git hooks`,
    );
  }
  if (wrote(".gitattributes")) {
    const crlf = await crlfTrackedFiles(root);
    if (crlf.length > 0) {
      const files = crlf.length === 1 ? "1 file is" : `${crlf.length} files are`;
      steps.push(
        `${files} stored with CRLF line endings; run \`git add --renormalize .\` so they follow .gitattributes`,
      );
    }
  }
  return steps;
}

/** Problems repokeeper can't fix itself; printed, but not counted as drift. */
export async function printWarnings(root: string, ctx: ModuleContext, io: Io): Promise<void> {
  if (ctx.config.modules.ci) {
    for (const { file, command } of await duplicateTestRuns(root, ctx.stacks)) {
      io.out(
        `note: ${file} also runs "${command}", which the repokeeper ci job now runs too; drop one of them to save CI time`,
      );
    }
  }
  if (!ctx.config.modules.editorconfig) return;
  const text = await readFile(join(root, ".gitattributes"), "utf8").catch(() => "");
  for (const { line, by } of overriddenAttributes(text, "editorconfig")) {
    io.out(
      `warning: .gitattributes: "${line}" has no effect because repokeeper's "${by}" comes later; move it below the repokeeper block to keep it`,
    );
  }
}

export function hasDrift(result: SyncResult): boolean {
  return result.decisions.some((d) => d.action !== "unchanged") || result.removals.some((r) => r.action !== "release");
}
