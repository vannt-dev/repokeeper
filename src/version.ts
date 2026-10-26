import { readFileSync } from "node:fs";

export const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/** The standard this build of repokeeper applies. Bump it whenever generated output changes. */
export const STANDARD_VERSION = "1.4.4";

export const TOOL_VERSIONS = {
  lefthook: "2.2.1",
  commitlintCli: "21.2.3",
  commitlintConventional: "21.2.3",
  semanticRelease: "25.0.9",
  semanticReleaseChangelog: "7.0.0",
  semanticReleaseGit: "11.0.1",
  semanticReleaseExec: "7.1.0",
  semanticReleaseGitlab: "13.3.3",
  // 10.x needs conventional-changelog-writer 9, and semantic-release 25's notes generator bundles 8
  conventionalCommitsPreset: "9.3.1",
  renovate: "44.149.2",
  // PyPA's `build`, which the publish job builds a Python package with
  pypaBuild: "1.6.1",
} as const;

/**
 * Actions used by jobs written straight into a repository's own workflows (the publish job), pinned by
 * commit. `repokeeper update` moves them while the key is as it wrote it; a newer commit of the same
 * action, from Dependabot, is not drift. They move with the same actions in the reusable workflows
 * here, which a test holds them to.
 */
export const ACTION_PINS = {
  checkout: { action: "actions/checkout", sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1" },
  setupNode: { action: "actions/setup-node", sha: "949feb2413d6458794dcd2491c4babbbce0c15c1", version: "v7.1.0" },
  setupPython: { action: "actions/setup-python", sha: "6d4fd22b20465ccc0f7354476588e8df7c9ca0e0", version: "v7.1.0" },
  pypiPublish: {
    action: "pypa/gh-action-pypi-publish",
    sha: "7245906fb61fa33a13554f9d5fb856fe61758086",
    version: "v1.14.3",
  },
} as const;

/** Repository hosting the reusable workflows that generated CI files call. */
export const REUSABLE_REPO = "vannt-dev/repokeeper";

/** Moving tag callers pin to: the major version of this repokeeper (v0 during 0.x). */
export const WORKFLOW_REF = `v${PACKAGE_VERSION.split(".")[0]}`;

/** The tag of this release, for callers that pin to it instead of following the major tag. */
export const EXACT_WORKFLOW_REF = `v${PACKAGE_VERSION}`;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
