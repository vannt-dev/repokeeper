import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rustStack } from "../src/stacks/rust.js";
import { tempDir } from "./helpers.js";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}
const CRATE = '[package]\nname = "demo"\nversion = "0.3.1"\nedition = "2021"\n';

it("is detected from Cargo.toml", async () => {
  expect(rustStack.detect(await repo({ "Cargo.toml": CRATE }))).toBe(true);
  expect(rustStack.detect(await repo({ "main.rs": "" }))).toBe(false);
});

it("checks formatting, runs clippy as errors and tests, and releases the crate version", async () => {
  const stack = await rustStack.resolve(await repo({ "Cargo.toml": CRATE }));
  expect(stack.ci).toEqual({
    workflow: "stack-rust.yml",
    with: {
      "rust-versions": '["stable"]',
      os: '["ubuntu-latest"]',
      commands: JSON.stringify([
        "cargo fmt --all --check",
        "cargo clippy --all-targets -- -D warnings",
        "cargo test --all-targets",
      ]),
    },
  });
  expect(stack.staged).toEqual([{ name: "rust:fmt", glob: "*.rs", run: "cargo fmt --all" }]);
  expect(stack.test).toBe("cargo test");
  expect(stack.install).toBe("cargo fetch");
  expect(stack.gitignore).toEqual(["Rust"]);
  expect(stack.dependabot).toEqual(["cargo"]);
  expect(stack.release).toEqual({ type: "rust", version: "0.3.1" });
});

it("releases a workspace root without a package as simple", async () => {
  const stack = await rustStack.resolve(await repo({ "Cargo.toml": '[workspace]\nmembers = ["a", "b"]\n' }));
  expect(stack.release).toEqual({ type: "simple", version: null });
  expect(JSON.parse(stack.ci?.with.commands ?? "")).toContain("cargo test --all-targets");
});
