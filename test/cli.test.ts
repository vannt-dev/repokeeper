import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { run } from "../src/cli.js";
import { compareVersions } from "../src/version.js";
import { capture } from "./helpers.js";

it("prints the package version", async () => {
  const c = capture();
  expect(await run(["--version"], c.io)).toBe(0);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(c.out).toEqual([pkg.version]);
});

it("rejects an unknown command with exit code 2 and usage", async () => {
  const c = capture();
  expect(await run(["frobnicate"], c.io)).toBe(2);
  expect(c.err.join("\n")).toContain("usage: repokeeper");
});

it("rejects an unknown option with exit code 2", async () => {
  const c = capture();
  expect(await run(["check", "--nope"], c.io)).toBe(2);
  expect(c.err.join("\n")).toContain("--nope");
});

it("compares semantic versions numerically", () => {
  expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("0.9.9", "1.0.0")).toBeLessThan(0);
});
