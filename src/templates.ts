import { readdirSync, readFileSync } from "node:fs";
import { normalizeEol } from "./sync/hash.js";

/** Reads a bundled template with LF endings; works from src/ (tests) and dist/ (package). */
export function readTemplate(relativePath: string): string {
  return normalizeEol(readFileSync(new URL(`../templates/${relativePath}`, import.meta.url), "utf8"));
}

/** File names of the reusable workflows generated CI and release files can call. */
export const REUSABLE_WORKFLOW = /^(stack-[a-z]+|commitlint|release-please|repokeeper-check)\.yml$/;

/** Reads one of the reusable workflows shipped with the package, with LF endings. */
export function readWorkflow(file: string): string {
  return normalizeEol(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
}

/** Every reusable workflow shipped with the package, by file name. */
export function listWorkflows(): string[] {
  return readdirSync(new URL("../.github/workflows/", import.meta.url))
    .filter((name) => REUSABLE_WORKFLOW.test(name))
    .sort();
}
