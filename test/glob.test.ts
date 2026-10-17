import { describe, expect, it } from "vitest";
import { globsToRegex } from "../src/glob.js";

describe("globsToRegex", () => {
  const matches = (globs: string[], path: string) => new RegExp(globsToRegex(globs)).test(path);

  it("reads * as one path segment and ** as any depth, like GitHub's path filters", () => {
    const docs = ["*.md", "docs/**", "LICENSE"];
    expect(matches(docs, "README.md")).toBe(true);
    expect(matches(docs, "docs/guide/setup.md")).toBe(true);
    expect(matches(docs, "LICENSE")).toBe(true);
    expect(matches(docs, "src/README.md")).toBe(false);
    expect(matches(docs, "LICENSE.txt")).toBe(false);
    expect(matches(docs, "src/index.ts")).toBe(false);
  });

  it("matches **/ as no directory or any", () => {
    expect(matches(["**/*.md"], "README.md")).toBe(true);
    expect(matches(["**/*.md"], "a/b/c.md")).toBe(true);
    expect(matches(["**/*.md"], "a/b/c.ts")).toBe(false);
  });

  it("escapes what a regular expression would read", () => {
    expect(matches(["a+b.(txt)"], "a+b.(txt)")).toBe(true);
    expect(matches(["a+b.(txt)"], "aab.(txt)")).toBe(false);
  });
});
