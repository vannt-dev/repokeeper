import { readFileSync } from "node:fs";

export const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/** The standard this build of repokeeper applies. Bump it whenever generated output changes. */
export const STANDARD_VERSION = "1.3.1";

export const TOOL_VERSIONS = {
  lefthook: "2.1.14",
  commitlintCli: "21.2.3",
  commitlintConventional: "21.2.3",
} as const;

/** Repository hosting the reusable workflows that generated CI files call. */
export const REUSABLE_REPO = "vannt-dev/repokeeper";

/** Moving tag callers pin to: the major version of this repokeeper (v0 during 0.x). */
export const WORKFLOW_REF = `v${PACKAGE_VERSION.split(".")[0]}`;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
