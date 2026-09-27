import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../errors.js";
import { GRADLE_FILES, gradleBuild } from "./gradle.js";
import { checkKeys, stringList } from "./support.js";
import type { StackPack } from "./types.js";

const OPTION_KEYS = ["versions", "os"];
const KOTLIN = /\bkotlin\(\s*"|org\.jetbrains\.kotlin/;
const ANDROID = /com\.android\.(application|library)/;

function buildFiles(root: string): { file: string; text: string }[] {
  return GRADLE_FILES.flatMap((file) => {
    try {
      return [{ file, text: readFileSync(join(root, file), "utf8") }];
    } catch {
      return [];
    }
  });
}

/** Whether a Gradle build at the root applies a Kotlin plugin. */
export const usesKotlin = (root: string) => buildFiles(root).some(({ text }) => KOTLIN.test(text));

export const kotlinStack: StackPack = {
  id: "kotlin",
  detect: usesKotlin,
  async resolve(root, options = {}) {
    checkKeys("kotlin", options, OPTION_KEYS);
    const android = buildFiles(root).find(({ text }) => ANDROID.test(text));
    if (android) {
      throw new UsageError(
        `${android.file} is an Android project, which needs the Android SDK the CI runners don't have; leave kotlin out of stacks`,
      );
    }
    const { command, release, wrapper } = await gradleBuild(root);
    return {
      id: "kotlin",
      // ktlint or Spotless run through the build, like Spotless for java
      staged: [],
      test: command,
      install: null,
      gitignore: ["Kotlin", "Gradle"],
      dependabot: ["gradle"],
      ci: {
        workflow: "stack-java.yml",
        with: {
          "java-versions": JSON.stringify(stringList("kotlin", options, "versions") ?? ["17", "21"]),
          os: JSON.stringify(stringList("kotlin", options, "os") ?? ["ubuntu-latest"]),
          "build-tool": "gradle",
          "gradle-version": wrapper ? "" : "current",
          commands: JSON.stringify([command]),
        },
      },
      release,
    };
  },
};
