import type { Module, ModuleContext, ReleaseType, ResolvedStack } from "../model.js";
import { pickReleaseStack } from "./release.js";

export type Registry = "npm" | "pypi";

/** The registry each release type publishes to; a type with no line here is not published. */
export const REGISTRIES: Partial<Record<ReleaseType, Registry>> = { node: "npm", python: "pypi" };

export type PublishPlan = { stack: ResolvedStack; registry: Registry } | { problem: string };

/**
 * What `modules.publish` publishes, or why it writes nothing: the released stack has to be one with a
 * registry, at the root. A stack in a folder is released by release-please under outputs named after
 * the folder, which the release workflow does not pass on.
 */
export function publishPlan(ctx: ModuleContext): PublishPlan {
  if (!ctx.config.modules.release) return { problem: "it publishes what modules.release releases, which is off" };
  const stack = pickReleaseStack(ctx.stacks);
  const registry = stack ? REGISTRIES[stack.release.type] : undefined;
  if (!stack || !registry) {
    return { problem: `it publishes node packages to npm and python packages to PyPI, and ${stack?.id} is neither` };
  }
  if (stack.directory) return { problem: `publishing a stack in a folder (${stack.directory}) is not supported` };
  return { stack, registry };
}

export const publishModule: Module = {
  id: "publish",
  enabled: (config) => config.modules.publish,
  outputs: (ctx) => {
    const plan = publishPlan(ctx);
    return "problem" in plan ? [] : ctx.platform.registryPublish(ctx, plan.stack, plan.registry);
  },
};
