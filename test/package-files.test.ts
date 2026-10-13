import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listWorkflows } from "../src/templates.js";

const { files } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };

/** Whether a `files` entry of package.json covers `path`; `*` stands for part of one file name. */
const shipped = (path: string) =>
  files.some((pattern) => {
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    return new RegExp(`^${source}$`).test(path);
  });

describe("the published package", () => {
  it("ships every reusable workflow a repository can be given a copy of", () => {
    // `github.workflows.source: local` reads them from the installed package, not from the repository
    const missing = listWorkflows().filter((name) => !shipped(`.github/workflows/${name}`));
    expect(missing).toEqual([]);
  });
});
