import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasDrift } from "../src/commands/report.js";
import type { Output } from "../src/model.js";
import { applySync } from "../src/sync/apply.js";
import { readLock } from "../src/sync/lock.js";
import { computeSync, pathsToWrite, type SyncOptions } from "../src/sync/sync.js";
import { tempDir } from "./helpers.js";

const none = { adopt: new Set<string>(), accept: new Set<string>() };
const v1: Output[] = [
  { kind: "file", module: "a", path: "nested/dir/a.txt", content: "a1\n" },
  { kind: "block", module: "b", path: ".gitignore", id: "b", comment: "hash", body: "dist/" },
  { kind: "json", module: "c", path: "package.json", keyPath: ["devDependencies", "lefthook"], value: "^2.1.14" },
];

async function syncTo(root: string, outputs: Output[], options: SyncOptions = none) {
  const lock = await readLock(root);
  const result = await computeSync(root, outputs, lock, options);
  await applySync(root, result, lock, "1.0.0");
  return result;
}

const actions = (result: Awaited<ReturnType<typeof computeSync>>) =>
  Object.fromEntries(result.decisions.map((d) => [d.output.path, d.action]));

describe("sync", () => {
  it("creates outputs, keeps existing content and records the lock", async () => {
    const root = await tempDir();
    await writeFile(join(root, ".gitignore"), "node_modules/");
    await writeFile(join(root, "package.json"), '{\r\n    "name": "x"\r\n}\r\n');
    const result = await syncTo(root, v1);
    expect(actions(result)).toEqual({ "nested/dir/a.txt": "create", ".gitignore": "create", "package.json": "create" });
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(
      "node_modules/\n\n# repokeeper:start b\ndist/\n# repokeeper:end b\n",
    );
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(
      '{\r\n    "name": "x",\r\n    "devDependencies": {\r\n        "lefthook": "^2.1.14"\r\n    }\r\n}\r\n',
    );
    expect((await readLock(root))?.entries.map((e) => e.id)).toHaveLength(3);
    expect(pathsToWrite(result).sort()).toEqual([".gitignore", "nested/dir/a.txt", "package.json"]);
  });

  it("updates untouched output and preserves edited output", async () => {
    const root = await tempDir();
    await syncTo(root, v1);
    await writeFile(join(root, "nested/dir/a.txt"), "mine\n");
    const v2: Output[] = [
      { ...v1[0], content: "a2\n" } as Output,
      { ...v1[1], body: "dist/\nbuild/" } as Output,
      v1[2] as Output,
    ];
    const result = await syncTo(root, v2);
    expect(actions(result)).toEqual({
      "nested/dir/a.txt": "conflict",
      ".gitignore": "write",
      "package.json": "unchanged",
    });
    expect(await readFile(join(root, "nested/dir/a.txt"), "utf8")).toBe("mine\n");
    expect(await readFile(join(root, "nested/dir/a.txt.repokeeper-new"), "utf8")).toBe("a2\n");
    // The conflict keeps its old lock entry, so it is still reported next time.
    const again = await computeSync(root, v2, await readLock(root), none);
    expect(actions(again)["nested/dir/a.txt"]).toBe("conflict");
  });

  it("accepts a conflicting file on request", async () => {
    const root = await tempDir();
    await syncTo(root, v1);
    await writeFile(join(root, "nested/dir/a.txt"), "mine\n");
    const v2: Output[] = [{ ...v1[0], content: "a2\n" } as Output];
    const result = await syncTo(root, v2, { adopt: new Set(), accept: new Set(["nested/dir/a.txt"]) });
    expect(actions(result)["nested/dir/a.txt"]).toBe("write");
    expect(await readFile(join(root, "nested/dir/a.txt"), "utf8")).toBe("a2\n");
  });

  it("does not take over existing files unless adopted", async () => {
    const root = await tempDir();
    await writeFile(join(root, "LICENSE"), "custom");
    const license: Output[] = [{ kind: "file", module: "health", path: "LICENSE", content: "MIT\n" }];
    expect(actions(await syncTo(root, license)).LICENSE).toBe("unmanaged");
    expect(await readFile(join(root, "LICENSE"), "utf8")).toBe("custom");
    expect(actions(await syncTo(root, license, { adopt: "all", accept: new Set() })).LICENSE).toBe("adopt");
    expect(await readFile(join(root, "LICENSE"), "utf8")).toBe("MIT\n");
  });

  it("removes output the standard dropped, unless the user edited it", async () => {
    const root = await tempDir();
    await syncTo(root, v1);
    await writeFile(join(root, "package.json"), '{"devDependencies":{"lefthook":"^9"}}');
    const result = await syncTo(root, []);
    expect(Object.fromEntries(result.removals.map((r) => [r.entry.target.path, r.action]))).toEqual({
      "nested/dir/a.txt": "delete",
      ".gitignore": "delete",
      "package.json": "orphan-edited",
    });
    expect(existsSync(join(root, "nested/dir/a.txt"))).toBe(false);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("");
    expect(await readFile(join(root, "package.json"), "utf8")).toContain("^9");
    expect((await readLock(root))?.entries).toEqual([]);
  });

  it("hands output over to the user when it becomes owned, without deleting it", async () => {
    const root = await tempDir();
    await syncTo(root, v1);
    const owned = ["nested/dir/a.txt", "package.json#devDependencies"];
    const result = await syncTo(root, v1.slice(1, 2), { ...none, owned });
    expect(Object.fromEntries(result.removals.map((r) => [r.entry.target.path, r.action]))).toEqual({
      "nested/dir/a.txt": "release",
      "package.json": "release",
    });
    expect(hasDrift(result)).toBe(false);
    expect(await readFile(join(root, "nested/dir/a.txt"), "utf8")).toBe("a1\n");
    expect(await readFile(join(root, "package.json"), "utf8")).toContain("lefthook");
    expect((await readLock(root))?.entries.map((e) => e.target.path)).toEqual([".gitignore"]);
  });
});
