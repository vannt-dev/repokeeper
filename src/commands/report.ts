import type { Io } from "../cli.js";
import { describeOutput, type Output } from "../model.js";
import type { RemovalAction } from "../sync/decide.js";
import type { SyncResult } from "../sync/sync.js";

export interface CommandOptions {
  dryRun: boolean;
  force: boolean;
  adopt: string[];
  adoptAll: boolean;
  accept: string[];
  stacks: import("../config/types.js").StackId[];
  relock: boolean;
  json: boolean;
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

export function hasDrift(result: SyncResult): boolean {
  return result.decisions.some((d) => d.action !== "unchanged") || result.removals.some((r) => r.action !== "release");
}
