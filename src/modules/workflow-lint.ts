import type { Module } from "../model.js";

export const workflowLintModule: Module = {
  id: "workflow_lint",
  enabled: (config) => config.modules.workflow_lint,
  outputs: (ctx) => ctx.platform.workflowLint(ctx),
};
