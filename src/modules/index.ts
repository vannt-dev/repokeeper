import type { Module } from "../model.js";
import { autoupdateModule } from "./autoupdate.js";
import { ciModule } from "./ci.js";
import { commitsModule } from "./commits.js";
import { depsModule } from "./deps.js";
import { editorconfigModule } from "./editorconfig.js";
import { gitignoreModule } from "./gitignore.js";
import { healthModule } from "./health.js";
import { hooksModule } from "./hooks.js";
import { releaseModule } from "./release.js";

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
];
