import type { Output } from "../model.js";
import { hashText } from "./hash.js";
import type { LockEntry } from "./lock.js";
import { desiredText } from "./state.js";

export type Action = "create" | "write" | "adopt" | "unchanged" | "conflict" | "unmanaged";
/** `left`: a seed that still exists; `release`: output the user now owns, left as it is and dropped from the lock. */
export type RemovalAction = "delete" | "orphan-edited" | "gone" | "left" | "release";

/**
 * `owner/repo[/path]@ref` of an action. A local action (`./…`), a Docker image (`docker://…`) and a
 * reusable workflow (`…/.github/workflows/…`) do not match or are left out below.
 */
const ACTION = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?)@[^@\s]+$/;

/** The value with the version of every action a step uses taken out, so only the action's name is left. */
function withoutActionVersions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutActionVersions);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key !== "steps" || !Array.isArray(item)) return [key, withoutActionVersions(item)];
      return [
        key,
        item.map((step) => {
          const uses = (step as { uses?: unknown } | null)?.uses;
          const action = typeof uses === "string" && !uses.includes("/.github/workflows/") ? ACTION.exec(uses) : null;
          const rest = withoutActionVersions(step) as Record<string, unknown>;
          return action ? { ...rest, uses: `${action[1]}@` } : rest;
        }),
      ];
    }),
  );
}

/**
 * Whether two YAML values (as JSON text) differ only in the versions of the actions their steps use: the
 * same action at another commit or tag, as a Dependabot pull request leaves it. The call of a reusable
 * workflow is not a step, so the ref it is pinned to still counts.
 */
export function sameIgnoringActionVersions(currentText: string, desiredJson: string): boolean {
  try {
    const loose = (json: string) => JSON.stringify(withoutActionVersions(JSON.parse(json)));
    return loose(currentText) === loose(desiredJson);
  } catch {
    return false;
  }
}

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
  // adding the two marker lines is always safe, so they are written without --adopt or --accept
  if (output.kind === "marker") return "write";
  if (entry) {
    // what repokeeper wrote and nobody touched is moved, pinned actions included
    if (current === entry.hash) return "write";
    // a newer version of the same action is the repository's to keep, not an edit to report
    if (output.kind === "yaml" && sameIgnoringActionVersions(currentText, desiredText(output))) return "unchanged";
    return "conflict";
  }
  return adopt ? "adopt" : "unmanaged";
}

/** For a lock entry the standard no longer produces. */
export function decideRemoval(entry: LockEntry, currentText: string | null): RemovalAction {
  if (currentText === null) return "gone";
  // other tools own a seed once it exists, and release-please uses the markers
  if (entry.target.kind === "seed" || entry.target.kind === "marker") return "left";
  return hashText(currentText) === entry.hash ? "delete" : "orphan-edited";
}
