import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type Output, YAML_HEADER } from "../src/model.js";
import { deleteYamlKey, readYamlKey, setYamlKey } from "../src/sync/yaml.js";
import { syncOnce, tempDir } from "./helpers.js";

const ORDER = ["name", "on", "jobs"];
const options = { header: "Managed.", order: ORDER };

describe("yaml keys", () => {
  it("creates a file with the header and keys in the given order", () => {
    let text = setYamlKey(null, "ci.yml", ["jobs", "node"], { uses: "x" }, options);
    text = setYamlKey(text, "ci.yml", ["name"], "ci", options);
    expect(text.startsWith("# Managed.\n")).toBe(true);
    expect(Object.keys(parse(text))).toEqual(["name", "jobs"]);
    expect(parse(text)).toEqual({ name: "ci", jobs: { node: { uses: "x" } } });
  });

  it("reads a key as JSON text, and null when it is absent", () => {
    const text = "name: ci\non:\n  pull_request: {}\n";
    expect(readYamlKey(text, ["on"], "ci.yml")).toBe('{"pull_request":{}}');
    expect(readYamlKey(text, ["jobs", "node"], "ci.yml")).toBeNull();
  });

  it("keeps comments, the user's keys and CRLF when replacing a key", () => {
    const text =
      "name: ci\r\n# my comment\r\njobs:\r\n  mine:\r\n    runs-on: ubuntu-latest\r\n  node:\r\n    uses: old\r\n";
    const next = setYamlKey(text, "ci.yml", ["jobs", "node"], { uses: "new" }, options);
    expect(next).toContain("# my comment\r\n");
    expect(next.replace(/\r\n/g, "")).not.toContain("\n");
    expect(parse(next)).toEqual({ name: "ci", jobs: { mine: { "runs-on": "ubuntu-latest" }, node: { uses: "new" } } });
  });

  it("writes null as an empty value, the way workflows spell `pull_request:`", () => {
    expect(setYamlKey(null, "ci.yml", ["on"], { pull_request: null }, options)).toContain("on:\n  pull_request:\n");
  });

  it("does not fold long commands", () => {
    const run = `echo ${"x".repeat(200)}`;
    expect(setYamlKey(null, "a.yml", ["run"], run, options)).toContain(`run: ${run}\n`);
  });

  it("deletes a key and the parents it empties, then reports an empty document", () => {
    const once = deleteYamlKey("name: ci\njobs:\n  node:\n    uses: x\n", "ci.yml", ["jobs", "node"]);
    expect(parse(once as string)).toEqual({ name: "ci" });
    expect(deleteYamlKey(once as string, "ci.yml", ["name"])).toBeNull();
  });

  describe("an existing workflow keeps its own formatting", () => {
    const USER = [
      "name: CI & Extension Build Checks",
      "",
      "on:",
      "  push:",
      "    branches: [ main, develop ]",
      "",
      "jobs:",
      "  build-and-test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "    - name: Checkout Repository",
      "      uses: actions/checkout@v4",
      "",
      "    - name: Run tests",
      "      run: npm test",
      "",
    ].join("\n");

    it("adds keys without touching the user's lines", () => {
      let text = setYamlKey(USER, "ci.yml", ["jobs", "commits"], { uses: "x" }, options);
      text = setYamlKey(text, "ci.yml", ["permissions"], { contents: "read" }, options);
      expect(text.startsWith(USER.slice(0, USER.indexOf("jobs:")))).toBe(true);
      expect(text).toContain("    branches: [ main, develop ]\n");
      expect(text).toContain("    steps:\n    - name: Checkout Repository\n      uses: actions/checkout@v4\n\n");
      expect(parse(text)).toEqual({
        ...parse(USER),
        permissions: { contents: "read" },
        jobs: { ...parse(USER).jobs, commits: { uses: "x" } },
      });
    });

    it("replaces and deletes only the managed key", () => {
      const added = setYamlKey(USER, "ci.yml", ["jobs", "commits"], { uses: "x" }, options);
      const replaced = setYamlKey(added, "ci.yml", ["jobs", "commits"], { uses: "y", with: { a: 1 } }, options);
      expect(replaced.replace(/\n {2}commits:[\s\S]*$/, "")).toBe(USER.replace(/\n$/, ""));
      expect(parse(replaced).jobs.commits).toEqual({ uses: "y", with: { a: 1 } });
      expect(deleteYamlKey(replaced, "ci.yml", ["jobs", "commits"])).toBe(USER);
    });

    it("places a new top-level key by the preferred order", () => {
      const order = { header: "Managed.", order: ["name", "on", "permissions", "jobs"] };
      const text = setYamlKey(USER, "ci.yml", ["permissions"], { contents: "read" }, order);
      expect(Object.keys(parse(text))).toEqual(["name", "on", "permissions", "jobs"]);
      expect(text).toContain("    branches: [ main, develop ]\n\npermissions:\n  contents: read\njobs:\n");
    });

    it("falls back to rewriting the file when a parent is written in flow style", () => {
      const text = setYamlKey(
        "name: ci\njobs: { mine: { runs-on: x } }\n",
        "ci.yml",
        ["jobs", "node"],
        { uses: "y" },
        options,
      );
      expect(parse(text)).toEqual({ name: "ci", jobs: { mine: { "runs-on": "x" }, node: { uses: "y" } } });
    });

    it("keeps CRLF line endings", () => {
      const crlf = USER.replace(/\n/g, "\r\n");
      const text = setYamlKey(crlf, "ci.yml", ["jobs", "commits"], { uses: "x" }, options);
      expect(text.startsWith(crlf.replace(/\r\n$/, ""))).toBe(true);
      expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    });
  });

  it("names the file when the YAML is invalid", () => {
    expect(() => readYamlKey("jobs: [a\n", ["jobs"], "ci.yml")).toThrow("ci.yml is not valid YAML");
  });
});

describe("yaml outputs through the sync engine", () => {
  const path = ".github/workflows/ci.yml";
  const job = (uses: string): Output => ({
    kind: "yaml",
    module: "ci",
    path,
    keyPath: ["jobs", "node"],
    value: { uses },
    order: ORDER,
  });
  const actions = async (root: string, outputs: Output[]) =>
    (await syncOnce(root, outputs)).decisions.map((d) => d.action);

  it("creates its key, leaves the user's jobs alone, reports edits and removes only its key", async () => {
    const root = await tempDir();
    const file = join(root, path);
    expect(await actions(root, [job("a")])).toEqual(["create"]);
    expect((await readFile(file, "utf8")).startsWith(`# ${YAML_HEADER}\n`)).toBe(true);

    await writeFile(file, `${await readFile(file, "utf8")}  mine:\n    runs-on: ubuntu-latest\n`);
    expect(await actions(root, [job("a")])).toEqual(["unchanged"]);
    expect(await actions(root, [job("b")])).toEqual(["write"]);

    await writeFile(file, (await readFile(file, "utf8")).replace("uses: b", "uses: edited"));
    expect(await actions(root, [job("c")])).toEqual(["conflict"]);
    expect(await readFile(file, "utf8")).toContain("uses: edited");

    await writeFile(file, (await readFile(file, "utf8")).replace("uses: edited", "uses: b"));
    const removed = await syncOnce(root, []);
    expect(removed.removals.map((r) => r.action)).toEqual(["delete"]);
    expect(parse(await readFile(file, "utf8"))).toEqual({ jobs: { mine: { "runs-on": "ubuntu-latest" } } });
  });
});
