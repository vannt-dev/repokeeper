import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { javaStack } from "../src/stacks/java.js";
import { tempDir } from "./helpers.js";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}
const POM = [
  "<project>",
  "  <parent>",
  "    <groupId>org.springframework.boot</groupId>",
  "    <version>3.5.0</version>",
  "  </parent>",
  "  <artifactId>demo</artifactId>",
  "  <version>2.3.0</version>",
  "  <dependencies>",
  "    <dependency>",
  "      <version>1.0.0</version>",
  "    </dependency>",
  "  </dependencies>",
  "</project>",
].join("\n");

it("is detected from pom.xml or a Gradle build file", async () => {
  expect(javaStack.detect(await repo({ "pom.xml": POM }))).toBe(true);
  expect(javaStack.detect(await repo({ "build.gradle": "" }))).toBe(true);
  expect(javaStack.detect(await repo({ "build.gradle.kts": "" }))).toBe(true);
  expect(javaStack.detect(await repo({ "Main.java": "" }))).toBe(false);
});

it("verifies a Maven project through its wrapper and reads the project's own version", async () => {
  const stack = await javaStack.resolve(await repo({ "pom.xml": POM, mvnw: "" }));
  expect(stack.ci).toEqual({
    workflow: "stack-java.yml",
    with: {
      "java-versions": '["17","21"]',
      os: '["ubuntu-latest"]',
      "build-tool": "maven",
      "gradle-version": "",
      commands: '["./mvnw -B verify"]',
    },
  });
  expect(stack.test).toBe("./mvnw -B verify");
  expect(stack.staged).toEqual([]);
  expect(stack.install).toBeNull();
  expect(stack.gitignore).toEqual(["Java", "Maven"]);
  expect(stack.dependabot).toEqual(["maven"]);
  expect(stack.release).toEqual({ type: "maven", version: "2.3.0" });
});

it("treats a property placeholder as no version", async () => {
  const stack = await javaStack.resolve(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a Maven property, not a JS template
    await repo({ "pom.xml": "<project>\n  <version>${revision}</version>\n</project>\n" }),
  );
  expect(stack.release).toEqual({ type: "maven", version: null });
  expect(stack.test).toBe("mvn -B verify");
});

it("checks a Gradle project, installing Gradle when there is no wrapper", async () => {
  const stack = await javaStack.resolve(await repo({ "build.gradle.kts": "", "gradle.properties": "version=1.4.0\n" }));
  expect(stack.ci?.with).toMatchObject({
    "build-tool": "gradle",
    "gradle-version": "current",
    commands: '["gradle check"]',
  });
  expect(stack.gitignore).toEqual(["Java", "Gradle"]);
  expect(stack.dependabot).toEqual(["gradle"]);
  expect(stack.release).toEqual({
    type: "simple",
    version: "1.4.0",
    extraFiles: ["gradle.properties"],
    versionLine: { path: "gradle.properties", line: "^version\\s*=" },
  });
});

it("uses the Gradle wrapper when present", async () => {
  const stack = await javaStack.resolve(await repo({ "build.gradle": "", gradlew: "" }));
  expect(stack.ci?.with).toMatchObject({ "gradle-version": "", commands: '["./gradlew check"]' });
  expect(stack.release).toEqual({ type: "simple", version: null });
});
