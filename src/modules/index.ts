import type { Module } from "../model.js";
import { automergeModule } from "./automerge.js";
import { autoupdateModule } from "./autoupdate.js";
import { cacheCleanupModule } from "./cache-cleanup.js";
import { ciModule } from "./ci.js";
import { commitsModule } from "./commits.js";
import { depsModule } from "./deps.js";
import { editorconfigModule } from "./editorconfig.js";
import { gitignoreModule } from "./gitignore.js";
import { healthModule } from "./health.js";
import { hooksModule } from "./hooks.js";
import { releaseModule } from "./release.js";
import { securityModule } from "./security.js";

export const MODULES: Module[] = [
  editorconfigModule,
  gitignoreModule,
  commitsModule,
  hooksModule,
  healthModule,
  depsModule,
  ciModule,
  releaseModule,
  autoupdateModule,
  securityModule,
  cacheCleanupModule,
  automergeModule,
];
