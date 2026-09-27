import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { ResolvedStack } from "./model.js";
import { REUSABLE_REPO } from "./version.js";

export interface DuplicateTestRun {
  file: string;
  command: string;
}

const WORKFLOWS = ".github/workflows";
const calls = (job: unknown) => {
  const uses = (job as { uses?: unknown } | null)?.uses;
  return (
    typeof uses === "string" && (uses.startsWith(`${REUSABLE_REPO}/`) || uses.startsWith("./.github/workflows/stack-"))
  );
};

/** Workflows of the user's own that run a stack's test command, which repokeeper's ci job now runs as well. */
export async function duplicateTestRuns(root: string, stacks: ResolvedStack[]): Promise<DuplicateTestRun[]> {
  const commands = stacks.map((s) => s.test).filter((c): c is string => c !== null);
  if (commands.length === 0) return [];
  const names = await readdir(join(root, WORKFLOWS)).catch(() => [] as string[]);
  const found: DuplicateTestRun[] = [];
  for (const name of names.filter((n) => /\.ya?ml$/.test(n)).sort()) {
    let workflow: { on?: unknown; jobs?: Record<string, unknown> } | null;
    try {
      workflow = parse(await readFile(join(root, WORKFLOWS, name), "utf8"));
    } catch {
      continue;
    }
    // only pull request CI overlaps with repokeeper's ci job; a release workflow testing before it publishes doesn't
    if (!JSON.stringify(workflow?.on ?? "").includes("pull_request")) continue;
    const jobs = workflow?.jobs ?? {};
    const own = JSON.stringify(Object.values(jobs).filter((job) => !calls(job)));
    for (const command of commands) {
      if (own.includes(command)) found.push({ file: `${WORKFLOWS}/${name}`, command });
    }
  }
  return found;
}
