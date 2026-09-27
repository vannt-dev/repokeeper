import { type Output, outputId } from "../model.js";
import { isOwned } from "../owned.js";
import { type Action, decide, decideRemoval, type RemovalAction } from "./decide.js";
import { type Lock, type LockEntry, targetOf } from "./lock.js";
import { readCurrent } from "./state.js";

export interface Decision {
  output: Output;
  action: Action;
}
export interface Removal {
  entry: LockEntry;
  action: RemovalAction;
}
export interface SyncResult {
  decisions: Decision[];
  removals: Removal[];
}
export interface SyncOptions {
  adopt: Set<string> | "all";
  accept: Set<string>;
  /** `owned` from the config; lock entries it covers are handed over instead of removed. */
  owned?: readonly string[];
}

export async function computeSync(
  root: string,
  outputs: Output[],
  lock: Lock | null,
  options: SyncOptions,
): Promise<SyncResult> {
  const entries = new Map((lock?.entries ?? []).map((e) => [e.id, e]));
  const decisions: Decision[] = [];
  for (const output of outputs) {
    const adopt = options.adopt === "all" || options.adopt.has(output.path);
    let action = decide(output, await readCurrent(root, targetOf(output)), entries.get(outputId(output)), adopt);
    if (action === "conflict" && options.accept.has(output.path)) action = "write";
    decisions.push({ output, action });
  }
  const wanted = new Set(outputs.map(outputId));
  const removals: Removal[] = [];
  for (const entry of entries.values()) {
    if (wanted.has(entry.id)) continue;
    const action = isOwned(options.owned ?? [], entry.target)
      ? "release"
      : decideRemoval(entry, await readCurrent(root, entry.target));
    removals.push({ entry, action });
  }
  return { decisions, removals };
}

const WRITES: Action[] = ["create", "write", "adopt"];

/** Existing paths a sync would change; guarded against uncommitted edits. */
export function pathsToWrite(result: SyncResult): string[] {
  return [
    ...new Set([
      ...result.decisions.filter((d) => WRITES.includes(d.action)).map((d) => d.output.path),
      ...result.removals.filter((r) => r.action === "delete").map((r) => r.entry.target.path),
    ]),
  ];
}
