import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseInfo } from "../model.js";
import { readText } from "./support.js";

export const GRADLE_FILES = ["build.gradle", "build.gradle.kts"];

/** The build command (wrapper when present) and release info of a Gradle project. */
export async function gradleBuild(root: string): Promise<{ command: string; release: ReleaseInfo; wrapper: boolean }> {
  const wrapper = existsSync(join(root, "gradlew"));
  const properties = await readText(root, "gradle.properties");
  const version = properties ? (/^version\s*=\s*(\S+)/m.exec(properties)?.[1] ?? null) : null;
  return {
    command: wrapper ? "./gradlew check" : "gradle check",
    wrapper,
    // release-please's generic updater only edits gradle.properties between x-release-please markers,
    // which the release module adds around the version line
    release: {
      type: "simple",
      version,
      ...(version !== null
        ? { extraFiles: ["gradle.properties"], versionLine: { path: "gradle.properties", line: "^version\\s*=" } }
        : {}),
    },
  };
}
