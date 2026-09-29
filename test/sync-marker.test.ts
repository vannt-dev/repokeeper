import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hasDrift } from "../src/commands/report.js";
import type { Output } from "../src/model.js";
import { syncOnce, tempDir } from "./helpers.js";

const path = "gradle.properties";
const marker: Output = { kind: "marker", module: "release", path, line: "^version\\s*=" };
const actions = async (root: string, outputs: Output[] = [marker]) =>
  (await syncOnce(root, outputs)).decisions.map((d) => d.action);
const read = (root: string) => readFile(join(root, path), "utf8");

it("wraps only the version line in release-please markers", async () => {
  const root = await tempDir();
  await writeFile(join(root, path), "# build settings\ngroup=com.example\nversion=0.3.0\norg.gradle.caching=true\n");

  expect(await actions(root)).toEqual(["write"]);
  expect(await read(root)).toBe(
    "# build settings\ngroup=com.example\n# x-release-please-start-version\nversion=0.3.0\n# x-release-please-end\norg.gradle.caching=true\n",
  );
  expect(await actions(root)).toEqual(["unchanged"]);
});

it("keeps CRLF line endings", async () => {
  const root = await tempDir();
  await writeFile(join(root, path), "version=1.0.0\r\n");

  await actions(root);
  expect(await read(root)).toBe("# x-release-please-start-version\r\nversion=1.0.0\r\n# x-release-please-end\r\n");
});

it("stays unchanged after release-please bumps the version", async () => {
  const root = await tempDir();
  await writeFile(join(root, path), "version=1.0.0\n");
  await actions(root);
  await writeFile(join(root, path), (await read(root)).replace("1.0.0", "1.1.0"));

  const result = await syncOnce(root, [marker]);
  expect(result.decisions.map((d) => d.action)).toEqual(["unchanged"]);
  expect(hasDrift(result)).toBe(false);
});

it("respects markers the user placed", async () => {
  for (const text of [
    "# x-release-please-start-version\nversion=2.0.0\n# x-release-please-end\n",
    "version=2.0.0\n# version above: x-release-please-version\n",
  ]) {
    const root = await tempDir();
    await writeFile(join(root, path), text);
    expect(await actions(root)).toEqual(["unchanged"]);
    expect(await read(root)).toBe(text);
  }
});

it("never creates the file, and leaves a file without a version line alone", async () => {
  const root = await tempDir();
  expect(await actions(root)).toEqual(["unchanged"]);
  expect(existsSync(join(root, path))).toBe(false);

  await writeFile(join(root, path), "org.gradle.caching=true\n");
  expect(await actions(root)).toEqual(["unchanged"]);
  expect(await read(root)).toBe("org.gradle.caching=true\n");
});

it("reports drift while the markers are missing", async () => {
  const root = await tempDir();
  await writeFile(join(root, path), "version=1.0.0\n");
  await actions(root);
  await writeFile(join(root, path), "version=1.0.0\n");

  const result = await syncOnce(root, [marker]);
  expect(result.decisions.map((d) => d.action)).toEqual(["write"]);
  expect(hasDrift(result)).toBe(true);
});

it("leaves the markers when the standard stops producing them", async () => {
  const root = await tempDir();
  await writeFile(join(root, path), "version=1.0.0\n");
  await actions(root);

  const result = await syncOnce(root, []);
  expect(result.removals.map((r) => r.action)).toEqual(["left"]);
  expect(await read(root)).toContain("# x-release-please-start-version\n");
});

it("does not recreate a deleted file", async () => {
  const root = await tempDir();
  await writeFile(join(root, path), "version=1.0.0\n");
  await actions(root);
  await rm(join(root, path));

  expect(await actions(root)).toEqual(["unchanged"]);
  expect(existsSync(join(root, path))).toBe(false);
});
