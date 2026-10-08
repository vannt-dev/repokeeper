import type { Module } from "../model.js";

export const depsModule: Module = {
  id: "deps",
  enabled: (config) => config.modules.deps,
  outputs: (ctx) =>
    ctx.platform.dependencyUpdates(
      ctx.stacks.flatMap((stack) =>
        stack.dependabot.map((ecosystem) => ({ ecosystem, directory: stack.directory ? `/${stack.directory}` : "/" })),
      ),
      ctx,
    ),
};
