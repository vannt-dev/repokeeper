import { parse } from "yaml";

/** The check the generated `ci.yml` reports once every other job of the run is done. */
export const CI_RESULT_CHECK = "CI result";

/** GitHub Actions, as the app a required check must come from. */
export const GITHUB_ACTIONS_APP_ID = 15368;

/** The check names a repository's workflows can report, read from the workflow files. */
export interface WorkflowChecks {
  /** Names a job reports as written: its `name`, or its id when it has none. */
  names: Set<string>;
  /** Names with an expression or a matrix in them, as patterns. */
  patterns: RegExp[];
  /** Jobs that call a reusable workflow: their checks are `<job> / <job inside>`, which only a run shows. */
  callers: RegExp[];
  /** Whether a workflow runs on pull requests at all; without one there is nothing to require. */
  pullRequests: boolean;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A job name as a pattern: `${{ … }}` matches whatever the expression turns into, and a matrix adds
 * ` (<values>)`. A caller of a reusable workflow also reports `<name> / <job inside>`.
 */
const namePattern = (name: string, caller = false) =>
  new RegExp(
    `^${name
      .split(/\$\{\{.*?\}\}/)
      .map(escapeRegex)
      .join(".*")}( \\(.*\\))?${caller ? "( / .+)?" : ""}$`,
  );

function triggers(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (typeof on === "object" && on !== null) return Object.keys(on);
  return [];
}

/**
 * Reads the check names that workflow files report. A workflow that only runs when another calls it
 * (`workflow_call`) reports nothing under its own job names, so its jobs are left out. A file that is
 * not valid YAML is skipped.
 */
export function workflowChecks(files: Iterable<string>): WorkflowChecks {
  const checks: WorkflowChecks = { names: new Set(), patterns: [], callers: [], pullRequests: false };
  for (const text of files) {
    let workflow: unknown;
    try {
      workflow = parse(text);
    } catch {
      continue;
    }
    if (typeof workflow !== "object" || workflow === null) continue;
    const { on, jobs } = workflow as { on?: unknown; jobs?: unknown };
    const events = triggers(on);
    if (events.length === 0 || events.every((event) => event === "workflow_call")) continue;
    if (events.some((event) => event === "pull_request" || event === "pull_request_target")) {
      checks.pullRequests = true;
    }
    if (typeof jobs !== "object" || jobs === null) continue;
    for (const [id, job] of Object.entries(jobs as Record<string, unknown>)) {
      const spec = (typeof job === "object" && job !== null ? job : {}) as {
        name?: unknown;
        uses?: unknown;
        strategy?: { matrix?: unknown };
      };
      const name = typeof spec.name === "string" && spec.name.length > 0 ? spec.name : id;
      if (typeof spec.uses === "string") {
        checks.callers.push(namePattern(name, true));
      } else if (name.includes("${{") || spec.strategy?.matrix !== undefined) {
        // a matrix job without its own name in the matrix reports `<name> (<values>)`
        checks.patterns.push(namePattern(name));
      } else {
        checks.names.add(name);
      }
    }
  }
  return checks;
}

/** Whether some job of the workflows reports `context`, as far as the files can tell. */
export function reportsCheck(checks: WorkflowChecks, context: string): boolean {
  if (checks.names.has(context)) return true;
  if (checks.patterns.some((pattern) => pattern.test(context))) return true;
  // the part after the slash comes from the reusable workflow, which may live in another repository
  return checks.callers.some((caller) => caller.test(context));
}
