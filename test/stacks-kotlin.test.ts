import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { kotlinStack } from "../src/stacks/kotlin.js";
import { tempDir } from "./helpers.js";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}
const KTS = 'plugins {\n    kotlin("jvm") version "2.4.20"\n}\n';

it("is detected from a Gradle build that applies a Kotlin plugin", async () => {
  expect(kotlinStack.detect(await repo({ "build.gradle.kts": KTS }))).toBe(true);
  expect(kotlinStack.detect(await repo({ "build.gradle": "apply plugin: 'org.jetbrains.kotlin.jvm'\n" }))).toBe(true);
  expect(kotlinStack.detect(await repo({ "build.gradle.kts": "plugins { java }\n" }))).toBe(false);
  expect(kotlinStack.detect(await repo({ "pom.xml": "<project/>" }))).toBe(false);
});

it("runs gradle check through the java workflow and releases gradle.properties", async () => {
  const stack = await kotlinStack.resolve(
    await repo({ "build.gradle.kts": KTS, gradlew: "", "gradle.properties": "version=1.4.0\n" }),
  );
  expect(stack.ci).toEqual({
    workflow: "stack-java.yml",
    with: {
      "java-versions": '["17","21"]',
      os: '["ubuntu-latest"]',
      "build-tool": "gradle",
      "gradle-version": "",
      commands: '["./gradlew check"]',
    },
  });
  expect(stack.test).toBe("./gradlew check");
  expect(stack.gitignore).toEqual(["Kotlin", "Gradle"]);
  expect(stack.dependabot).toEqual(["gradle"]);
  expect(stack.release).toEqual({
    type: "simple",
    version: "1.4.0",
    extraFiles: ["gradle.properties"],
    versionLine: { path: "gradle.properties", line: "^version\\s*=" },
  });
});

it("refuses Android projects, naming the build file", async () => {
  const android = 'plugins {\n    id("com.android.application")\n    kotlin("android")\n}\n';
  await expect(kotlinStack.resolve(await repo({ "build.gradle.kts": android }))).rejects.toThrow(
    "build.gradle.kts is an Android project",
  );
});

it("reads version-catalog plugin aliases, and ignores kotlinx dependencies and comments", async () => {
  expect(
    kotlinStack.detect(await repo({ "build.gradle.kts": "plugins {\n    alias(libs.plugins.kotlin.jvm)\n}\n" })),
  ).toBe(true);
  const coroutines =
    'plugins { java }\ndependencies {\n    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")\n}\n';
  expect(kotlinStack.detect(await repo({ "build.gradle.kts": coroutines }))).toBe(false);
  expect(kotlinStack.detect(await repo({ "build.gradle.kts": 'plugins {\n    java\n    // kotlin("jvm")\n}\n' }))).toBe(
    false,
  );
  const android =
    "plugins {\n    alias(libs.plugins.android.application) apply false\n    alias(libs.plugins.kotlin.android) apply false\n}\n";
  await expect(kotlinStack.resolve(await repo({ "build.gradle.kts": android }))).rejects.toThrow(
    "build.gradle.kts is an Android project",
  );
});

it("releases gradle.properties only when it has a version line", async () => {
  const stack = await kotlinStack.resolve(
    await repo({ "build.gradle.kts": KTS, "gradle.properties": "org.gradle.caching=true\n" }),
  );
  expect(stack.release).toEqual({ type: "simple", version: null });
});
