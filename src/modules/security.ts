import type { Module } from "../model.js";

export const securityModule: Module = {
  id: "security",
  enabled: (config) => config.modules.security,
  outputs: (ctx) => ctx.platform.codeScanning(ctx),
};
