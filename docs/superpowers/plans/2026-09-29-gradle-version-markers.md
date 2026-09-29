# Gradle Version Markers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** repokeeper wraps the `version=` line of `gradle.properties` in release-please block markers once, so Gradle releases bump the version.

**Architecture:** A new output kind, `marker`, flows through the existing sync pipeline:
- model: `outputId`, `describeOutput`;
- lock: target kind;
- state: `desiredText`/`readCurrent`;
- decide: always `write` when unmarked, `left` on removal;
- apply: insert the lines.

The Gradle stack reports a `versionLine`, and the release module turns it into a `marker` output.

**Tech Stack:** TypeScript (ESM), vitest, biome.

**Spec:** `docs/superpowers/specs/2026-09-29-gradle-version-markers-design.md`

## Global Constraints

- Marker lines are exactly `# x-release-please-start-version` and `# x-release-please-end`.
- Existing markers are detected by `/x-release-please-(start-version|version)\b/` anywhere in the file.
- A `marker` output never creates a file and never changes a byte outside the two inserted lines. It keeps CRLF or LF.
- Standard moves to `1.4.3`.
- Commit messages follow commitlint (body lines ≤ 100 characters) and carry no trailers.
- Verify with `npm test`, `npm run lint`, `npx tsc --noEmit -p .`, and `node dist/cli.js check` after `npm run build`.

## Review Focus

1. **A `version=` line that is not first in the file, among other properties and comments**, gets markers around that line only. Pinned in Task 1 (`wraps only the version line`).
2. **A version bumped by release-please inside the markers** is not drift. Pinned in Task 1 (`stays unchanged after release-please bumps the version`).
3. **Markers the user placed themselves**, inline or block, are left alone. Pinned in Task 1 (`respects markers the user placed`).
4. **`gradle.properties` without a version line** gets no `extra-files` and no marker. Pinned in Task 2.
5. **The file or the line removed later** must not make repokeeper recreate the file. Pinned in Task 1 (`never creates the file`).

---

### Task 1: The `marker` output kind

**Files:**
- Create: `src/sync/marker.ts`
- Modify: `src/model.ts`, `src/sync/lock.ts`, `src/sync/state.ts`, `src/sync/decide.ts`, `src/sync/apply.ts`
- Test: `test/sync-marker.test.ts`

**Interfaces:**
- Produces:
  - `MarkerOutput` (in `Output`);
  - Target `{ kind: "marker"; path: string; line: string }`;
  - `markerState(text: string | null, line: string): string`;
  - `addMarkers(text: string, line: string): string`;
  - `MARKER_START`, `MARKER_END`.

- [ ] **Step 1: Write the failing tests** in `test/sync-marker.test.ts`

```ts
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
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `npx vitest run test/sync-marker.test.ts`
Expected: type errors or failures, because `kind: "marker"` is unknown.

- [ ] **Step 3: Create `src/sync/marker.ts`**

```ts
/** release-please's block markers for a version in a file its generic updater edits. */
export const MARKER_START = "# x-release-please-start-version";
export const MARKER_END = "# x-release-please-end";

const HAS_MARKERS = /x-release-please-(start-version|version)\b/;
const UNMARKED = "unmarked";

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function lineIndex(lines: string[], line: string): number {
  const pattern = new RegExp(line);
  return lines.findIndex((l) => pattern.test(l));
}

/** "" when there is nothing to add (no file, no matching line, or markers already present), else "unmarked". */
export function markerState(text: string | null, line: string): string {
  if (text === null || HAS_MARKERS.test(text)) return "";
  return lineIndex(text.split(eolOf(text)), line) === -1 ? "" : UNMARKED;
}

/** The text with block markers around the first line matching `line`; unchanged when there is nothing to add. */
export function addMarkers(text: string, line: string): string {
  if (markerState(text, line) === "") return text;
  const eol = eolOf(text);
  const lines = text.split(eol);
  const index = lineIndex(lines, line);
  lines.splice(index, 1, MARKER_START, lines[index] as string, MARKER_END);
  return lines.join(eol);
}
```

- [ ] **Step 4: Wire the kind through the pipeline.**

`src/model.ts`:
- Add, after `YamlOutput`:

```ts
/** release-please version markers around one line of a file the user owns, such as gradle.properties' `version=`. */
export interface MarkerOutput {
  kind: "marker";
  path: string;
  /** Regular expression source of the line to wrap. */
  line: string;
  module: string;
}
```

- Extend the union: `export type Output = FileOutput | SeedOutput | BlockOutput | JsonOutput | YamlOutput | MarkerOutput;`
- In `outputId`, add as the first line: `if (output.kind === "marker") return \`marker:${output.path}\`;`
- In `describeOutput`, add as the first line: `if (output.kind === "marker") return \`${output.path} (release-please version markers)\`;`

`src/sync/lock.ts`:
- Add `| { kind: "marker"; path: string; line: string }` to `Target`.
- In `targetOf`, add as the first line: `if (output.kind === "marker") return { kind: "marker", path: output.path, line: output.line };`

`src/sync/state.ts`:
- Import `markerState` from `./marker.js`.
- In `desiredText`, add `if (output.kind === "marker") return "";` next to the seed case.
- In `readCurrent`, before `if (text === null) return null;`, add:

```ts
  // markers are added to a file the user owns; a missing file or line means there is nothing to add
  if (target.kind === "marker") return markerState(text, target.line);
```

`src/sync/decide.ts`:
- In `decide`, after the `unchanged` check, add:

```ts
  // adding the two marker lines is always safe, so they are written without --adopt or --accept
  if (output.kind === "marker") return "write";
```

- In `decideRemoval`, change the seed line to `if (entry.target.kind === "seed" || entry.target.kind === "marker") return "left";`.

`src/sync/apply.ts`:
- Import `addMarkers` from `./marker.js`.
- In `write`, after `const existing = await readOrNull(path);`, add:

```ts
  if (output.kind === "marker") return existing === null ? undefined : put(path, addMarkers(existing, output.line));
```

- In `remove`, change `if (target.kind === "seed") return;` to `if (target.kind === "seed" || target.kind === "marker") return;`.

Run `npx tsc --noEmit -p .`. Any other exhaustive switch over `Output`/`Target` kinds that the compiler flags (`src/owned.ts`, `src/commands/report.ts`) gets the marker case with the same meaning as a seed.

- [ ] **Step 5: Run the tests and confirm they pass.**
Run: `npx vitest run test/sync-marker.test.ts && npm test`
Expected: all pass.

- [ ] **Step 6: Commit.**

```bash
git add src test/sync-marker.test.ts
git commit -m "feat(sync): add a marker output that wraps a line in release-please version markers"
```

---

### Task 2: Gradle stack and release module

**Files:**
- Modify: `src/model.ts` (`ReleaseInfo.versionLine`), `src/stacks/gradle.ts`, `src/modules/release.ts`
- Test: `test/stacks-kotlin.test.ts`, `test/stacks-java.test.ts`, `test/modules-ci-release.test.ts`

**Interfaces:**
- Consumes: `MarkerOutput` (Task 1).
- Produces: `ReleaseInfo.versionLine?: { path: string; line: string }`.

- [ ] **Step 1: Write the failing tests.**

In `test/stacks-kotlin.test.ts` and `test/stacks-java.test.ts`, change each expectation
`toEqual({ type: "simple", version: "1.4.0", extraFiles: ["gradle.properties"] })` to:

```ts
  expect(stack.release).toEqual({
    type: "simple",
    version: "1.4.0",
    extraFiles: ["gradle.properties"],
    versionLine: { path: "gradle.properties", line: "^version\\s*=" },
  });
```

Append to `test/stacks-kotlin.test.ts`:

```ts
it("releases gradle.properties only when it has a version line", async () => {
  const stack = await kotlinStack.resolve(
    await repo({ "build.gradle.kts": KTS, "gradle.properties": "org.gradle.caching=true\n" }),
  );
  expect(stack.release).toEqual({ type: "simple", version: null });
});
```

Append to the `release module` describe block in `test/modules-ci-release.test.ts` (or at the end of the file, in a new `describe("release module markers", ...)`):

```ts
  it("wraps the version line in markers when the release names one", () => {
    const versionLine = { path: "gradle.properties", line: "^version\\s*=" };
    const outputs = releaseModule.outputs(
      makeContext({ stacks: [nodeResolved({ release: { type: "simple", version: "1.0.0", versionLine } })] }),
    );
    expect(outputs.filter((o) => o.kind === "marker")).toEqual([
      { kind: "marker", module: "release", path: "gradle.properties", line: "^version\\s*=" },
    ]);
    expect(releaseModule.outputs(makeContext()).some((o) => o.kind === "marker")).toBe(false);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `npx vitest run test/stacks-kotlin.test.ts test/stacks-java.test.ts test/modules-ci-release.test.ts`
Expected: FAIL (no `versionLine`, no marker output).

- [ ] **Step 3: Implement.**

`src/model.ts`, in `ReleaseInfo`, add:

```ts
  /** The line holding the version in a file release-please only updates between markers (gradle.properties). */
  versionLine?: { path: string; line: string };
```

`src/stacks/gradle.ts`: replace the returned `release` and its comment with:

```ts
    // release-please's generic updater only edits gradle.properties between x-release-please markers,
    // which the release module adds around the version line
    release: {
      type: "simple",
      version,
      ...(version !== null
        ? { extraFiles: ["gradle.properties"], versionLine: { path: "gradle.properties", line: "^version\\s*=" } }
        : {}),
    },
```

`src/modules/release.ts`: replace `outputs` with:

```ts
  outputs: (ctx) => {
    const release = pickRelease(ctx.stacks);
    const markers: Output[] = release.versionLine
      ? [{ kind: "marker", module: "release", path: release.versionLine.path, line: release.versionLine.line }]
      : [];
    return [...ctx.platform.releaseAutomation(ctx, release), ...markers];
  },
```

and import `Output` in the type import.

- [ ] **Step 4: Run the tests and confirm they pass.**
Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add src test
git commit -m "fix(release): add release-please markers around the gradle.properties version"
```

---

### Task 3: End to end, standard 1.4.3, docs

**Files:**
- Modify: `test/e2e.test.ts`, `src/version.ts`, `.repokeeper.yml`, `.repokeeper/lock.json` (via `update`), `README.md` (only if it describes Gradle releases)

- [ ] **Step 1: Write the failing e2e test.** Add after the `it.each` stack test in `test/e2e.test.ts`:

```ts
  it("wraps the gradle.properties version in release-please markers", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "build.gradle.kts"), 'plugins {\n    kotlin("jvm") version "2.4.20"\n}\n');
    await writeFile(join(dir, "gradle.properties"), "group=com.example\nversion=0.3.0\n");
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.name", "Demo User");
    sh(dir, "config", "user.email", "demo@example.com");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: initial");

    expect((await repokeeper(dir, "init")).code).toBe(0);
    expect(await readFile(join(dir, "gradle.properties"), "utf8")).toBe(
      "group=com.example\n# x-release-please-start-version\nversion=0.3.0\n# x-release-please-end\n",
    );
    commitAll(dir);
    expect((await repokeeper(dir, "check")).code).toBe(0);
  });
```

- [ ] **Step 2: Run it.** Run `npx vitest run test/e2e.test.ts`. It passes if Tasks 1–2 are complete, because e2e runs the built CLI or the sources as the file already does. If it passes immediately, that is expected: this test pins the wiring end to end. Record that in the ledger.

- [ ] **Step 3: Move the standard.** In `src/version.ts`, set `STANDARD_VERSION = "1.4.3"`. Then:

```bash
npm run build && node dist/cli.js update && node dist/cli.js check
npm test && npm run lint && npx tsc --noEmit -p .
```

Expected: `update` changes only `.repokeeper.yml` and `.repokeeper/lock.json`, `check` reports the repository matches, and everything passes.

- [ ] **Step 4: README.** `grep -n -i gradle README.md`. If a sentence describes how Gradle versions are released, add: "repokeeper wraps the `version=` line of `gradle.properties` in release-please markers so releases bump it." Otherwise change nothing.

- [ ] **Step 5: Commit** (two commits, matching earlier standard moves):

```bash
git add src/version.ts test/e2e.test.ts README.md
git commit -m "test: cover gradle.properties markers end to end and move the standard to 1.4.3"
git add .repokeeper.yml .repokeeper/lock.json
git commit -m "chore(repokeeper): update standard to 1.4.3"
```
