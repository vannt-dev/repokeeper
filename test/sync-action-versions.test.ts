import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import type { Output } from "../src/model.js";
import { decide, sameIgnoringActionVersions } from "../src/sync/decide.js";
import { hashText } from "../src/sync/hash.js";
import { type LockEntry, targetOf } from "../src/sync/lock.js";
import { desiredText } from "../src/sync/state.js";
import { ACTION_PINS } from "../src/version.js";
import { capture, tempDir } from "./helpers.js";

const OURS = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const NEWER = "1111111111111111111111111111111111111111";
const job = (checkout: string, run = "npm publish --access public", call?: string) => ({
  needs: "release",
  ...(call ? { uses: call } : {}),
  steps: [
    { uses: checkout, with: { "persist-credentials": false } },
    { name: "Publish", run },
  ],
});
const output: Output = {
  kind: "yaml",
  module: "publish",
  path: ".github/workflows/release.yml",
  keyPath: ["jobs", "publish"],
  value: job(`actions/checkout@${OURS}`),
};
const text = (value: unknown) => JSON.stringify(value);
const lockEntry = (written: unknown): LockEntry => ({
  id: "yaml:x",
  module: "publish",
  hash: hashText(text(written)),
  target: targetOf(output),
});
const ours = lockEntry(output.value);

describe("a version-only change of an action a step uses", () => {
  it("is not an edit: Dependabot moving the commit or the tag leaves the key unchanged", () => {
    expect(decide(output, text(job(`actions/checkout@${NEWER}`)), ours, false)).toBe("unchanged");
    expect(decide(output, text(job("actions/checkout@v8.0.0")), ours, false)).toBe("unchanged");
  });

  it("is moved by repokeeper while the key is still what it wrote", () => {
    // repokeeper wrote NEWER before; the standard now pins OURS, and nobody touched the file
    const before = job(`actions/checkout@${NEWER}`);
    expect(decide(output, text(before), lockEntry(before), false)).toBe("write");
  });

  it("is still an edit when the action itself or anything else in the key changed", () => {
    expect(decide(output, text(job(`someone/checkout@${OURS}`)), ours, false)).toBe("conflict");
    expect(decide(output, text(job(`actions/checkout@${NEWER}`, "npm publish")), ours, false)).toBe("conflict");
    expect(decide(output, text({ ...job(`actions/checkout@${NEWER}`), "runs-on": "self-hosted" }), ours, false)).toBe(
      "conflict",
    );
  });

  it("does not cover the call of a reusable workflow, whose ref repokeeper pins on purpose", () => {
    const call = (ref: string) => ({ uses: `vannt-dev/repokeeper/.github/workflows/release-please.yml@${ref}` });
    const caller: Output = { ...output, keyPath: ["jobs", "release"], value: call("v0") };
    expect(decide(caller, text(call("main")), lockEntry(call("v0")), false)).toBe("conflict");
    expect(sameIgnoringActionVersions(text(call("main")), text(call("v0")))).toBe(false);
  });

  it("does not take over a key repokeeper never wrote", () => {
    expect(decide(output, text(job(`actions/checkout@${NEWER}`)), undefined, false)).toBe("unmanaged");
  });

  it("leaves local actions and docker images alone", () => {
    const local = (path: string) => ({ steps: [{ uses: path }] });
    expect(sameIgnoringActionVersions(text(local("./a")), text(local("./b")))).toBe(false);
    expect(sameIgnoringActionVersions(text(local("docker://alpine:3.20")), text(local("docker://alpine:3.21")))).toBe(
      false,
    );
    // an action in a subfolder of its repository is still the same action
    const sub = (ref: string) => ({ steps: [{ uses: `github/codeql-action/init@${ref}` }] });
    expect(sameIgnoringActionVersions(text(sub("v3")), text(sub(OURS)))).toBe(true);
  });

  it("only applies to YAML keys", () => {
    const file: Output = { kind: "file", module: "m", path: "a.yml", content: `uses: actions/checkout@${OURS}\n` };
    const written = { ...ours, hash: hashText(desiredText(file)) };
    expect(decide(file, `uses: actions/checkout@${NEWER}\n`, written, false)).toBe("conflict");
  });
});

describe("check after Dependabot bumps the publish job", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

  it("reports no drift for a new commit of the same action, and drift for any other edit", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: "demo", version: "1.0.0" })}\n`);
    await writeFile(
      join(dir, ".repokeeper.yml"),
      "schema: 1\nstandard: 1.0.0\nplatform: github\nstacks: [node]\nmodules:\n  publish: true\n  health: false\n",
    );
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "Demo");
    git(dir, "config", "user.email", "demo@example.com");
    git(dir, "config", "core.autocrlf", "false");
    git(dir, "remote", "add", "origin", "https://github.com/demo-owner/demo.git");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "chore: initial");
    const cli = async (...args: string[]) => {
      const c = capture(dir);
      return { code: await run(args, c.io), out: c.out.join("\n") };
    };
    expect((await cli("init")).code).toBe(0);
    const path = join(dir, ".github/workflows/release.yml");
    const written = await readFile(path, "utf8");
    const pin = `${ACTION_PINS.setupNode.action}@${ACTION_PINS.setupNode.sha}`;
    expect(written).toContain(pin);

    // what a Dependabot pull request does: a new commit, and the comment it keeps beside it
    await writeFile(path, written.replace(pin, `${ACTION_PINS.setupNode.action}@${NEWER} # v7.2.0`));
    expect(await cli("check")).toMatchObject({ code: 0 });
    // nor is the bump undone, or reported, by update
    const update = await cli("update");
    expect(update.code).toBe(0);
    expect(await readFile(path, "utf8")).toContain(`@${NEWER} # v7.2.0`);

    await writeFile(path, written.replace("npm publish --access public", "npm publish"));
    expect((await cli("check")).code).toBe(1);
  });
});
