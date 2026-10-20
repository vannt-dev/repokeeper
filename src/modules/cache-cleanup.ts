import type { Module } from "../model.js";

export const cacheCleanupModule: Module = {
  id: "cache_cleanup",
  enabled: (config) => config.modules.cache_cleanup,
  outputs: (ctx) => ctx.platform.cacheCleanup(ctx),
};
