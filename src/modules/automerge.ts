import type { Module } from "../model.js";

export const automergeModule: Module = {
  id: "automerge",
  enabled: (config) => config.modules.automerge,
  outputs: (ctx) => ctx.platform.dependencyAutomerge(ctx),
};
