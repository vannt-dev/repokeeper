import type { Output } from "../model.js";
import { hashText } from "./hash.js";
import type { LockEntry } from "./lock.js";
import { desiredText } from "./state.js";

export type Action = "create" | "write" | "adopt" | "unchanged" | "conflict" | "unmanaged";
/** `left`: a seed that still exists; `release`: output the user now owns, left as it is and dropped from the lock. */
export type RemovalAction = "delete" | "orphan-edited" | "gone" | "left" | "release";

/** The update decision table from the spec, section 7. */
export function decide(
  output: Output,
  currentText: string | null,
  entry: LockEntry | undefined,
  adopt: boolean,
): Action {
  if (currentText === null) return "create";
  const current = hashText(currentText);
  if (current === hashText(desiredText(output))) return "unchanged";
  if (entry) return current === entry.hash ? "write" : "conflict";
  return adopt ? "adopt" : "unmanaged";
}

/** For a lock entry the standard no longer produces. */
export function decideRemoval(entry: LockEntry, currentText: string | null): RemovalAction {
  if (currentText === null) return "gone";
  if (entry.target.kind === "seed") return "left"; // other tools own a seed once it exists
  return hashText(currentText) === entry.hash ? "delete" : "orphan-edited";
}
