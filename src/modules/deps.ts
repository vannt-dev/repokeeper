import { depsSettings } from "../config/types.js";
import type { Module } from "../model.js";

export const depsModule: Module = {
  id: "deps",
  enabled: (config) => depsSettings(config) !== null,
  outputs: (ctx) =>
    ctx.platform.dependencyUpdates(
      ctx.stacks.flatMap((stack) =>
        stack.dependabot.map((ecosystem) => ({ ecosystem, directory: stack.directory ? `/${stack.directory}` : "/" })),
      ),
      ctx,
    ),
};
