import type { PlatformId } from "../config/types.js";
import type { PlatformAdapter } from "../model.js";
import { githubPlatform } from "./github.js";
import { gitlabPlatform } from "./gitlab.js";

export function platformFor(id: PlatformId): PlatformAdapter {
  return id === "gitlab" ? gitlabPlatform : githubPlatform;
}
