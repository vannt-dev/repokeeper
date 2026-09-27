import { expect, it } from "vitest";
import { overriddenAttributes } from "../src/sync/attributes.js";

const BLOCK =
  "# repokeeper:start editorconfig\n* text=auto eol=lf\n*.ps1 text eol=crlf\n*.png binary\n# repokeeper:end editorconfig\n";

it("names the user's lines that repokeeper's block silently overrides", () => {
  const text = `*.ps1 text eol=lf\n*.sh text eol=lf\n*.png -diff\n\n${BLOCK}`;
  expect(overriddenAttributes(text, "editorconfig")).toEqual([
    { line: "*.ps1 text eol=lf", by: "*.ps1 text eol=crlf" },
  ]);
});

it("leaves lines after the block alone, since those win", () => {
  expect(overriddenAttributes(`${BLOCK}*.ps1 text eol=lf\n`, "editorconfig")).toEqual([]);
});

it("reports nothing without the block", () => {
  expect(overriddenAttributes("*.ps1 text eol=lf\n", "editorconfig")).toEqual([]);
});
