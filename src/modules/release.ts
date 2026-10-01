import type { Module, Output, ReleaseInfo, ResolvedStack } from "../model.js";

/** One release per repository: the first stack with a language release type wins, otherwise the first stack's `simple` release (which may name extra files). */
export function pickRelease(stacks: ResolvedStack[]): ReleaseInfo {
  const language = stacks.find((stack) => stack.release.type !== "simple");
  return language?.release ?? stacks[0]?.release ?? { type: "simple", version: null };
}

export const releaseModule: Module = {
  id: "release",
  enabled: (config) => config.modules.release,
  outputs: (ctx) => {
    const release = pickRelease(ctx.stacks);
    const markers: Output[] = release.versionLine
      ? [{ kind: "marker", module: "release", path: release.versionLine.path, line: release.versionLine.line }]
      : [];
    return [...ctx.platform.releaseAutomation(ctx, release), ...markers];
  },
};
