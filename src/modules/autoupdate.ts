import type { Module } from "../model.js";

export const autoupdateModule: Module = {
  id: "autoupdate",
  enabled: (config) => config.modules.autoupdate,
  outputs: (ctx) => ctx.platform.standardUpdates(ctx),
};
