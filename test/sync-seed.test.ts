import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { printResult } from "../src/commands/report.js";
import type { Output } from "../src/model.js";
import { readLock } from "../src/sync/lock.js";
import { capture, syncOnce, tempDir } from "./helpers.js";

const path = ".release-please-manifest.json";
const manifest = (version: string): Output => ({
  kind: "seed",
  module: "release",
  path,
  content: `{ ".": "${version}" }\n`,
});
const actions = async (root: string, outputs: Output[]) =>
  (await syncOnce(root, outputs)).decisions.map((d) => d.action);

it("creates a seed once, then never rewrites or reports it", async () => {
  const root = await tempDir();
  expect(await actions(root, [manifest("0.1.0")])).toEqual(["create"]);
  await writeFile(join(root, path), '{ ".": "0.4.2" }\n');
  expect(await actions(root, [manifest("0.1.0")])).toEqual(["unchanged"]);
  expect(await readFile(join(root, path), "utf8")).toBe('{ ".": "0.4.2" }\n');
});

it("takes over an existing file without --adopt", async () => {
  const root = await tempDir();
  await writeFile(join(root, path), '{ ".": "2.0.0" }\n');
  expect(await actions(root, [manifest("0.1.0")])).toEqual(["unchanged"]);
  expect((await readLock(root))?.entries.map((e) => e.id)).toEqual([`seed:${path}`]);
});

it("recreates a deleted seed", async () => {
  const root = await tempDir();
  await actions(root, [manifest("0.1.0")]);
  await rm(join(root, path));
  expect(await actions(root, [manifest("0.1.0")])).toEqual(["create"]);
});

it("leaves the file in place when the module stops producing it, and says so", async () => {
  const root = await tempDir();
  await actions(root, [manifest("0.1.0")]);
  const result = await syncOnce(root, []);
  expect(result.removals.map((r) => r.action)).toEqual(["left"]);
  expect(existsSync(join(root, path))).toBe(true);
  const c = capture();
  printResult(c.io, result);
  expect(c.out[0]).toBe(
    `left       ${path} (no longer generated; left for the tools that use it, delete it if none do)`,
  );
  expect((await syncOnce(root, [])).removals).toEqual([]);
});

it("forgets a seed that was deleted after the module stopped producing it", async () => {
  const root = await tempDir();
  await actions(root, [manifest("0.1.0")]);
  await rm(join(root, path));
  expect((await syncOnce(root, [])).removals.map((r) => r.action)).toEqual(["gone"]);
});
