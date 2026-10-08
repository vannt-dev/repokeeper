import type { Module, Output, ReleaseInfo, ResolvedStack } from "../model.js";

/** One release per repository: the first stack with a language release type wins, otherwise the first stack's `simple` release (which may name extra files). */
export function pickReleaseStack(stacks: ResolvedStack[]): ResolvedStack | undefined {
  return stacks.find((stack) => stack.release.type !== "simple") ?? stacks[0];
}

export function pickRelease(stacks: ResolvedStack[]): ReleaseInfo {
  return pickReleaseStack(stacks)?.release ?? { type: "simple", version: null };
}

export const releaseModule: Module = {
  id: "release",
  enabled: (config) => config.modules.release,
  outputs: (ctx) => {
    const stack = pickReleaseStack(ctx.stacks);
    const release = stack?.release ?? { type: "simple", version: null };
    const directory = stack?.directory;
    // the markers go into a file of the repository, so its path starts at the root
    const markerPath = (path: string) => (directory ? `${directory}/${path}` : path);
    const markers: Output[] = release.versionLine
      ? [
          {
            kind: "marker",
            module: "release",
            path: markerPath(release.versionLine.path),
            line: release.versionLine.line,
          },
        ]
      : [];
    return [...ctx.platform.releaseAutomation(ctx, release, directory), ...markers];
  },
};
