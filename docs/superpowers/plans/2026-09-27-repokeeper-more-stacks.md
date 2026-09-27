# repokeeper More Stacks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add go, rust, kotlin, php and ruby stack packs (phase 2, part 1), each with a reusable CI workflow, a fixture exercised in CI, and release-please support, released as repokeeper 0.4.0 with standard 1.3.0.

**Architecture:** Every pack follows the existing shape: `detect(root)` looks for the build file, `resolve(root, options)` reads the project and returns a `ResolvedStack` (staged hook jobs, test and install commands, gitignore templates, Dependabot ecosystems, a CI job and release info). Each pack gets a reusable `stack-<id>.yml` in this repository and a fixture under `fixtures/<id>` that `workflow-tests.yml` runs. Kotlin reuses `stack-java.yml` (same Gradle toolchain) and takes precedence over `java` when a Kotlin plugin is present.

**Tech Stack:** TypeScript (Node ≥ 22.12), Vitest, Biome, GitHub Actions, release-please.

**Spec:** `docs/superpowers/specs/2026-09-25-repokeeper-design.md` (sections 5 "Stack packs" and 12 "Delivery order", phase 2). Decisions taken with the owner on 2026-09-27: stack packs before the GitLab adapter; Kotlin is its own stack; GitLab (a later plan) will use semantic-release.

## Global Constraints

- Node.js 22.12 or newer; no new runtime dependencies.
- Every action in a reusable workflow is pinned by a 40-character commit SHA with the tag in a comment (`test/workflows.test.ts` enforces it).
- Loops that read commands with `while IFS= read -r` feed each command `</dev/null` (enforced by the same test).
- Commit messages follow Conventional Commits, header at most 100 characters, body lines at most 100, and no `Co-Authored-By` or other trailers.
- Only `fix:`/`feat:` commits that should appear in the changelog; this plan's work releases as `feat` → 0.4.0.
- The standard version moves once, to `1.3.0`, in Task 7.
- Pinned action versions (looked up 2026-09-27):
  - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
  - `actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0`
  - `shivammathur/setup-php@f3e473d116dcccaddc5834248c87452386958240 # 2.37.2`
  - `ruby/setup-ruby@14594264cd68ce8a2345dd349bc3d138a4ef85c8 # v1.327.0`
- gitignore templates are copied verbatim from github/gitignore at commit `b06d69d5a0b82a187180dac3d46a4ebe1e40bce5`.
- Only `cargo` is available on the development machine; Go, PHP, Ruby and Gradle fixtures are verified by the pull request's `workflow-tests` run.

## Review Focus

1. A Rust workspace root (`[workspace]`, no `[package]`) — expect no version and release type `simple`, not a crash or a `rust` release that release-please can't bump. Test in Task 3.
2. A Kotlin Android project (`com.android.application` / `com.android.library`) — expect `init` to stop with a message naming the build file, since CI runners have no Android SDK. Test in Task 4.
3. A Gradle project with a Kotlin plugin — expect only `kotlin` detected, never `kotlin` and `java` together (two CI jobs running the same build). Test in Task 4.
4. A PHP project without PHPUnit or a `test` script — expect `test: null` and CI still running `composer validate --strict`. Test in Task 5.
5. A Ruby gem whose version lives only in the gemspec — expect that version and no `version-file`. Test in Task 6.

---

### Task 1: Release groundwork for the new stacks

**Files:**
- Modify: `src/model.ts` (the `ReleaseType` union and `ReleaseInfo`)
- Modify: `src/platforms/github.ts` (`releaseAutomation`, around the `"release-type"` entry)
- Modify: `src/stacks/support.ts` (add `tomlSection`)
- Modify: `src/stacks/python.ts` (use `tomlSection`)
- Test: `test/modules-non-node.test.ts` (the `describe("release extra files", …)` block)

**Interfaces:**
- Produces: `ReleaseType = "node" | "python" | "dart" | "maven" | "go" | "rust" | "php" | "ruby" | "simple"`; `ReleaseInfo.versionFile?: string` written as release-please's `version-file`; `tomlSection(toml: string, name: string): string` in `src/stacks/support.ts` returning the body of the `[name]` table or `""`.

- [ ] **Step 1: Write the failing test**

Add to the `describe("release extra files", …)` block in `test/modules-non-node.test.ts`:

```ts
  it("writes version-file for stacks that keep their version in a source file", () => {
    const release = { type: "ruby" as const, version: "1.2.0", versionFile: "lib/demo/version.rb" };
    const outputs = releaseModule.outputs(makeContext({ stacks: [nodeResolved({ release })] }));
    const pkg = JSON.parse(file(outputs, "release-please-config.json").content).packages["."];
    expect(pkg["release-type"]).toBe("ruby");
    expect(pkg["version-file"]).toBe("lib/demo/version.rb");
  });
```

Add to `test/stacks-python.test.ts`:

```ts
import { tomlSection } from "../src/stacks/support.js";

it("reads a TOML table by name", () => {
  const toml = '[project]\nname = "a"\n\n[tool.mypy]\nfiles = ["src"]\n';
  expect(tomlSection(toml, "tool.mypy")).toContain('files = ["src"]');
  expect(tomlSection(toml, "tool.ruff")).toBe("");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/modules-non-node.test.ts test/stacks-python.test.ts`
Expected: FAIL — `"ruby"` is not assignable to `ReleaseType` (type error at transform) and `tomlSection` is not exported.

- [ ] **Step 3: Implement**

In `src/model.ts`:

```ts
export type ReleaseType = "node" | "python" | "dart" | "maven" | "go" | "rust" | "php" | "ruby" | "simple";
```

and add to `ReleaseInfo`:

```ts
  /** Source file holding the version, for release types that need one named (ruby's version.rb). */
  versionFile?: string;
```

In `src/platforms/github.ts`, inside the `packages["."]` object of `releaseAutomation`, after the `extra-files` spread:

```ts
              ...(release.versionFile ? { "version-file": release.versionFile } : {}),
```

In `src/stacks/support.ts`:

```ts
/** The body of the `[name]` table of a TOML file, or "". */
export function tomlSection(toml: string, name: string): string {
  return toml.split(/^\[/m).find((part) => part.startsWith(`${name}]`)) ?? "";
}
```

In `src/stacks/python.ts`, delete the local `section` function, import `tomlSection` from `./support.js`, and replace both `section(` calls with `tomlSection(`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/model.ts src/platforms/github.ts src/stacks/support.ts src/stacks/python.ts test/modules-non-node.test.ts test/stacks-python.test.ts
git commit -m "feat(release): support go, rust, php and ruby release types and version-file"
```

---

### Task 2: go stack

**Files:**
- Create: `src/stacks/go.ts`
- Create: `.github/workflows/stack-go.yml`
- Create: `templates/gitignore/Go.gitignore`
- Create: `fixtures/go/go.mod`, `fixtures/go/fixture.go`, `fixtures/go/fixture_test.go`
- Modify: `src/config/types.ts` (`STACK_IDS`), `src/stacks/index.ts` (`PACKS`)
- Modify: `.github/workflows/workflow-tests.yml` (new `go` job)
- Modify: `test/workflows.test.ts` (`REUSABLE`, `FIXTURES`), `test/config.test.ts` (enum message)
- Test: `test/stacks-go.test.ts`

**Interfaces:**
- Consumes: `StackPack` (`src/stacks/types.ts`), `checkKeys`, `stringList` (`src/stacks/support.ts`), `ReleaseType "go"` (Task 1).
- Produces: `goStack: StackPack` with id `"go"`; workflow `stack-go.yml` with inputs `go-versions`, `os`, `commands`, `working-directory`.

- [ ] **Step 1: Write the failing test**

Create `test/stacks-go.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { goStack } from "../src/stacks/go.js";
import { tempDir } from "./helpers.js";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

it("is detected from go.mod", async () => {
  expect(goStack.detect(await repo({ "go.mod": "module example.com/a\n" }))).toBe(true);
  expect(goStack.detect(await repo({ "main.go": "" }))).toBe(false);
});

it("checks formatting, vets and tests every package, and releases from tags", async () => {
  const stack = await goStack.resolve(await repo({ "go.mod": "module example.com/a\n\ngo 1.22\n" }));
  expect(stack.ci).toEqual({
    workflow: "stack-go.yml",
    with: {
      "go-versions": '["stable"]',
      os: '["ubuntu-latest"]',
      commands: JSON.stringify(['test -z "$(gofmt -l .)" || { gofmt -l .; exit 1; }', "go vet ./...", "go test ./..."]),
    },
  });
  expect(stack.staged).toEqual([{ name: "go:gofmt", glob: "*.go", run: "gofmt -w {staged_files}" }]);
  expect(stack.test).toBe("go test ./...");
  expect(stack.install).toBe("go mod download");
  expect(stack.gitignore).toEqual(["Go"]);
  expect(stack.dependabot).toEqual(["gomod"]);
  expect(stack.release).toEqual({ type: "go", version: null });
});

it("takes Go versions and runners from stack_options", async () => {
  const stack = await goStack.resolve(await repo({ "go.mod": "module a\n" }), { versions: ["1.23", "1.24"], os: ["windows-latest"] });
  expect(stack.ci?.with).toMatchObject({ "go-versions": '["1.23","1.24"]', os: '["windows-latest"]' });
  await expect(goStack.resolve(await repo({ "go.mod": "module a\n" }), { lint: true })).rejects.toThrow(
    "stack_options.go.lint is not a known key",
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/stacks-go.test.ts`
Expected: FAIL — cannot find module `../src/stacks/go.js`.

- [ ] **Step 3: Implement the pack and register it**

Create `src/stacks/go.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkKeys, stringList } from "./support.js";
import type { StackPack } from "./types.js";

const OPTION_KEYS = ["versions", "os"];
const GOFMT = 'test -z "$(gofmt -l .)" || { gofmt -l .; exit 1; }';

export const goStack: StackPack = {
  id: "go",
  detect: (root) => existsSync(join(root, "go.mod")),
  async resolve(_root, options = {}) {
    checkKeys("go", options, OPTION_KEYS);
    return {
      id: "go",
      staged: [{ name: "go:gofmt", glob: "*.go", run: "gofmt -w {staged_files}" }],
      test: "go test ./...",
      install: "go mod download",
      gitignore: ["Go"],
      dependabot: ["gomod"],
      ci: {
        workflow: "stack-go.yml",
        with: {
          "go-versions": JSON.stringify(stringList("go", options, "versions") ?? ["stable"]),
          os: JSON.stringify(stringList("go", options, "os") ?? ["ubuntu-latest"]),
          commands: JSON.stringify([GOFMT, "go vet ./...", "go test ./..."]),
        },
      },
      // Go modules are versioned by their tags; the manifest starts from the latest one
      release: { type: "go", version: null },
    };
  },
};
```

In `src/config/types.ts` change `STACK_IDS` to:

```ts
export const STACK_IDS = ["node", "python", "dart", "script", "java", "dotnet", "go"] as const;
```

In `src/stacks/index.ts` import `goStack` from `./go.js` and add `go: goStack,` to `PACKS`.

In `test/config.test.ts` update the enum expectation in "lists the allowed values of an enum" to end with `…, java, dotnet, go`.

- [ ] **Step 4: Add the gitignore template**

```bash
curl -fsSL https://raw.githubusercontent.com/github/gitignore/b06d69d5a0b82a187180dac3d46a4ebe1e40bce5/Go.gitignore -o templates/gitignore/Go.gitignore
```

- [ ] **Step 5: Add the reusable workflow**

Create `.github/workflows/stack-go.yml`:

```yaml
name: stack-go

on:
  workflow_call:
    inputs:
      go-versions:
        description: JSON list of Go versions for actions/setup-go ("stable", "1.24")
        type: string
        default: '["stable"]'
      os:
        description: JSON list of runner labels
        type: string
        default: '["ubuntu-latest"]'
      commands:
        description: JSON list of shell commands run in order
        type: string
        default: '["go vet ./...","go test ./..."]'
      working-directory:
        description: Directory holding go.mod
        type: string
        default: .

permissions:
  contents: read

jobs:
  go:
    name: go ${{ matrix.go }} (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: ${{ fromJSON(inputs.os) }}
        go: ${{ fromJSON(inputs.go-versions) }}
    runs-on: ${{ matrix.os }}
    permissions:
      contents: read
    defaults:
      run:
        shell: bash
        working-directory: ${{ inputs.working-directory }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0
        with:
          go-version: ${{ matrix.go }}
          # modules without dependencies have no go.sum to key the cache on
          cache: ${{ hashFiles(format('{0}/go.sum', inputs.working-directory)) != '' }}
          cache-dependency-path: ${{ inputs.working-directory }}/go.sum
      - name: Run checks
        env:
          COMMANDS: ${{ inputs.commands }}
        run: |
          node -e 'for (const c of JSON.parse(process.env.COMMANDS)) console.log(c)' | while IFS= read -r command; do
            echo "::group::$command"
            bash -c "$command" </dev/null
            echo "::endgroup::"
          done
```

- [ ] **Step 6: Add the fixture and its CI job**

`fixtures/go/go.mod`:

```
module example.com/fixture

go 1.22
```

`fixtures/go/fixture.go`:

```go
// Package fixture exercises the stack-go workflow.
package fixture

// Add returns the sum of a and b.
func Add(a, b int) int {
	return a + b
}
```

`fixtures/go/fixture_test.go`:

```go
package fixture

import "testing"

func TestAdd(t *testing.T) {
	if got := Add(1, 2); got != 3 {
		t.Fatalf("Add(1, 2) = %d, want 3", got)
	}
}
```

Append to `jobs:` in `.github/workflows/workflow-tests.yml`:

```yaml
  go:
    uses: ./.github/workflows/stack-go.yml
    with:
      working-directory: fixtures/go
      os: '["ubuntu-latest","windows-latest"]'
      go-versions: '["stable"]'
      commands: '["test -z \"$(gofmt -l .)\" || { gofmt -l .; exit 1; }","go vet ./...","go test ./..."]'
```

In `test/workflows.test.ts` add `"stack-go.yml",` to `REUSABLE`, `import { goStack } from "../src/stacks/go.js";`, and `{ job: "go", dir: "fixtures/go", pack: goStack },` to `FIXTURES`.

- [ ] **Step 7: Run everything**

Run: `npx biome check --write . && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: PASS. The fixture's `commands` in `workflow-tests.yml` must equal what the pack resolves (the "is exercised by workflow-tests" test compares them).

- [ ] **Step 8: Commit**

```bash
git add src/stacks/go.ts src/stacks/index.ts src/config/types.ts .github/workflows/stack-go.yml .github/workflows/workflow-tests.yml templates/gitignore/Go.gitignore fixtures/go test/stacks-go.test.ts test/workflows.test.ts test/config.test.ts
git commit -m "feat(stacks): add the go pack with gofmt, go vet and go test"
```

---

### Task 3: rust stack

**Files:**
- Create: `src/stacks/rust.ts`, `.github/workflows/stack-rust.yml`, `templates/gitignore/Rust.gitignore`
- Create: `fixtures/rust/Cargo.toml`, `fixtures/rust/src/lib.rs`, `fixtures/rust/.gitignore`
- Modify: `src/config/types.ts`, `src/stacks/index.ts`, `.github/workflows/workflow-tests.yml`, `test/workflows.test.ts`, `test/config.test.ts`
- Test: `test/stacks-rust.test.ts`

**Interfaces:**
- Consumes: `tomlSection`, `ReleaseType "rust"` (Task 1), `checkKeys`, `stringList`, `readText`.
- Produces: `rustStack: StackPack` with id `"rust"`; workflow `stack-rust.yml` with inputs `rust-versions`, `os`, `commands`, `working-directory`.

- [ ] **Step 1: Write the failing test**

Create `test/stacks-rust.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/stacks-rust.test.ts`
Expected: FAIL — cannot find module `../src/stacks/rust.js`.

- [ ] **Step 3: Implement the pack and register it**

Create `src/stacks/rust.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseInfo } from "../model.js";
import { checkKeys, readText, stringList, tomlSection } from "./support.js";
import type { StackPack } from "./types.js";

const OPTION_KEYS = ["versions", "os"];

export const rustStack: StackPack = {
  id: "rust",
  detect: (root) => existsSync(join(root, "Cargo.toml")),
  async resolve(root, options = {}) {
    checkKeys("rust", options, OPTION_KEYS);
    const cargo = (await readText(root, "Cargo.toml")) ?? "";
    const pkg = tomlSection(cargo, "package");
    const version = /^version\s*=\s*"([^"]+)"/m.exec(pkg)?.[1] ?? null;
    // a workspace root without its own package has nothing for release-please's rust updater to bump
    const release: ReleaseInfo = pkg ? { type: "rust", version } : { type: "simple", version: null };
    return {
      id: "rust",
      staged: [{ name: "rust:fmt", glob: "*.rs", run: "cargo fmt --all" }],
      test: "cargo test",
      install: "cargo fetch",
      gitignore: ["Rust"],
      dependabot: ["cargo"],
      ci: {
        workflow: "stack-rust.yml",
        with: {
          "rust-versions": JSON.stringify(stringList("rust", options, "versions") ?? ["stable"]),
          os: JSON.stringify(stringList("rust", options, "os") ?? ["ubuntu-latest"]),
          commands: JSON.stringify([
            "cargo fmt --all --check",
            "cargo clippy --all-targets -- -D warnings",
            "cargo test --all-targets",
          ]),
        },
      },
      release,
    };
  },
};
```

Add `"rust"` to `STACK_IDS` (after `"go"`), `rust: rustStack` to `PACKS`, and `, rust` to the enum expectation in `test/config.test.ts`.

- [ ] **Step 4: Add the gitignore template**

```bash
curl -fsSL https://raw.githubusercontent.com/github/gitignore/b06d69d5a0b82a187180dac3d46a4ebe1e40bce5/Rust.gitignore -o templates/gitignore/Rust.gitignore
```

- [ ] **Step 5: Add the reusable workflow**

Create `.github/workflows/stack-rust.yml`:

```yaml
name: stack-rust

on:
  workflow_call:
    inputs:
      rust-versions:
        description: JSON list of rustup toolchains ("stable", "1.85.0")
        type: string
        default: '["stable"]'
      os:
        description: JSON list of runner labels
        type: string
        default: '["ubuntu-latest"]'
      commands:
        description: JSON list of shell commands run in order
        type: string
        default: '["cargo test --all-targets"]'
      working-directory:
        description: Directory holding Cargo.toml
        type: string
        default: .

permissions:
  contents: read

jobs:
  rust:
    name: rust ${{ matrix.rust }} (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: ${{ fromJSON(inputs.os) }}
        rust: ${{ fromJSON(inputs.rust-versions) }}
    runs-on: ${{ matrix.os }}
    permissions:
      contents: read
    defaults:
      run:
        shell: bash
        working-directory: ${{ inputs.working-directory }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Install the toolchain
        env:
          TOOLCHAIN: ${{ matrix.rust }}
        # rustup ships on the hosted runners
        run: |
          rustup toolchain install "$TOOLCHAIN" --profile minimal --component rustfmt,clippy
          rustup default "$TOOLCHAIN"
      - name: Run checks
        env:
          COMMANDS: ${{ inputs.commands }}
        run: |
          node -e 'for (const c of JSON.parse(process.env.COMMANDS)) console.log(c)' | while IFS= read -r command; do
            echo "::group::$command"
            bash -c "$command" </dev/null
            echo "::endgroup::"
          done
```

The `pins every action by commit SHA` test only inspects `uses:` steps, so the `rustup` step needs no pin.

- [ ] **Step 6: Add the fixture and its CI job**

`fixtures/rust/Cargo.toml`:

```toml
[package]
name = "fixture"
version = "0.0.0"
edition = "2021"
publish = false
```

`fixtures/rust/src/lib.rs`:

```rust
//! Fixture for the stack-rust workflow.

/// Returns the sum of `a` and `b`.
pub fn add(a: i64, b: i64) -> i64 {
    a + b
}

#[cfg(test)]
mod tests {
    use super::add;

    #[test]
    fn adds() {
        assert_eq!(add(1, 2), 3);
    }
}
```

`fixtures/rust/.gitignore`:

```
target/
Cargo.lock
```

Verify locally (cargo is installed): `cd fixtures/rust && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test --all-targets`
Expected: all three succeed, `test tests::adds ... ok`.

Append to `.github/workflows/workflow-tests.yml`:

```yaml
  rust:
    uses: ./.github/workflows/stack-rust.yml
    with:
      working-directory: fixtures/rust
      os: '["ubuntu-latest","windows-latest"]'
      rust-versions: '["stable"]'
      commands: '["cargo fmt --all --check","cargo clippy --all-targets -- -D warnings","cargo test --all-targets"]'
```

In `test/workflows.test.ts` add `"stack-rust.yml"` to `REUSABLE`, import `rustStack`, and add `{ job: "rust", dir: "fixtures/rust", pack: rustStack }` to `FIXTURES`.

- [ ] **Step 7: Run everything**

Run: `npx biome check --write . && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/stacks/rust.ts src/stacks/index.ts src/config/types.ts .github/workflows/stack-rust.yml .github/workflows/workflow-tests.yml templates/gitignore/Rust.gitignore fixtures/rust test/stacks-rust.test.ts test/workflows.test.ts test/config.test.ts
git commit -m "feat(stacks): add the rust pack with rustfmt, clippy and cargo test"
```

---

### Task 4: kotlin stack (Gradle, sharing the java workflow)

**Files:**
- Create: `src/stacks/gradle.ts` (Gradle resolution shared by java and kotlin)
- Create: `src/stacks/kotlin.ts`, `templates/gitignore/Kotlin.gitignore`
- Create: `fixtures/kotlin/settings.gradle.kts`, `fixtures/kotlin/build.gradle.kts`, `fixtures/kotlin/gradle.properties`, `fixtures/kotlin/src/main/kotlin/Greeter.kt`, `fixtures/kotlin/src/test/kotlin/GreeterTest.kt`
- Modify: `src/stacks/java.ts` (use `gradle.ts`), `src/stacks/index.ts` (`PACKS`, `detectStacks`), `src/config/types.ts`
- Modify: `.github/workflows/workflow-tests.yml`, `test/workflows.test.ts`, `test/config.test.ts`
- Test: `test/stacks-kotlin.test.ts`, `test/stacks.test.ts`

**Interfaces:**
- Consumes: `stack-java.yml` inputs (`java-versions`, `os`, `build-tool`, `gradle-version`, `commands`, `working-directory`).
- Produces: `gradleBuild(root: string): Promise<{ command: string; release: ReleaseInfo; wrapper: boolean }>` in `src/stacks/gradle.ts`; `kotlinStack: StackPack` with id `"kotlin"`; `usesKotlin(root: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `test/stacks-kotlin.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { kotlinStack } from "../src/stacks/kotlin.js";
import { tempDir } from "./helpers.js";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}
const KTS = 'plugins {\n    kotlin("jvm") version "2.4.20"\n}\n';

it("is detected from a Gradle build that applies a Kotlin plugin", async () => {
  expect(kotlinStack.detect(await repo({ "build.gradle.kts": KTS }))).toBe(true);
  expect(kotlinStack.detect(await repo({ "build.gradle": "apply plugin: 'org.jetbrains.kotlin.jvm'\n" }))).toBe(true);
  expect(kotlinStack.detect(await repo({ "build.gradle.kts": "plugins { java }\n" }))).toBe(false);
  expect(kotlinStack.detect(await repo({ "pom.xml": "<project/>" }))).toBe(false);
});

it("runs gradle check through the java workflow and releases gradle.properties", async () => {
  const stack = await kotlinStack.resolve(
    await repo({ "build.gradle.kts": KTS, gradlew: "", "gradle.properties": "version=1.4.0\n" }),
  );
  expect(stack.ci).toEqual({
    workflow: "stack-java.yml",
    with: {
      "java-versions": '["17","21"]',
      os: '["ubuntu-latest"]',
      "build-tool": "gradle",
      "gradle-version": "",
      commands: '["./gradlew check"]',
    },
  });
  expect(stack.test).toBe("./gradlew check");
  expect(stack.gitignore).toEqual(["Kotlin", "Gradle"]);
  expect(stack.dependabot).toEqual(["gradle"]);
  expect(stack.release).toEqual({ type: "simple", version: "1.4.0", extraFiles: ["gradle.properties"] });
});

it("refuses Android projects, naming the build file", async () => {
  const android = 'plugins {\n    id("com.android.application")\n    kotlin("android")\n}\n';
  await expect(kotlinStack.resolve(await repo({ "build.gradle.kts": android }))).rejects.toThrow(
    "build.gradle.kts is an Android project",
  );
});
```

Add to `test/stacks.test.ts` (it already imports `detectStacks` and defines `repoWith(files)`):

```ts
it("detects kotlin instead of java for a Gradle build with a Kotlin plugin", async () => {
  const dir = await repoWith({ "build.gradle.kts": 'plugins {\n    kotlin("jvm") version "2.4.20"\n}\n' });
  expect(await detectStacks(dir)).toEqual(["kotlin"]);
  expect(await detectStacks(await repoWith({ "build.gradle.kts": "plugins { java }\n" }))).toEqual(["java"]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/stacks-kotlin.test.ts test/stacks.test.ts`
Expected: FAIL — cannot find module `../src/stacks/kotlin.js`.

- [ ] **Step 3: Extract the Gradle resolution**

Create `src/stacks/gradle.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseInfo } from "../model.js";
import { readText } from "./support.js";

export const GRADLE_FILES = ["build.gradle", "build.gradle.kts"];

/** The build command (wrapper when present) and release info of a Gradle project. */
export async function gradleBuild(root: string): Promise<{ command: string; release: ReleaseInfo; wrapper: boolean }> {
  const wrapper = existsSync(join(root, "gradlew"));
  const properties = await readText(root, "gradle.properties");
  const version = properties ? (/^version\s*=\s*(\S+)/m.exec(properties)?.[1] ?? null) : null;
  return {
    command: wrapper ? "./gradlew check" : "gradle check",
    wrapper,
    // release-please's generic updater changes gradle.properties once it carries x-release-please markers
    release: { type: "simple", version, ...(properties !== null ? { extraFiles: ["gradle.properties"] } : {}) },
  };
}
```

In `src/stacks/java.ts` replace the Gradle `else` branch with:

```ts
    } else {
      ({ command, release } = await gradleBuild(root));
    }
```

import `gradleBuild` from `./gradle.js`, and change the `"gradle-version"` input to `!maven && !has("gradlew") ? "current" : ""` (unchanged behaviour; keep it). Run `npx vitest run test/stacks-java.test.ts` — Expected: PASS (pure refactor).

- [ ] **Step 4: Implement the kotlin pack and register it**

Create `src/stacks/kotlin.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../errors.js";
import { GRADLE_FILES, gradleBuild } from "./gradle.js";
import { checkKeys, stringList } from "./support.js";
import type { StackPack } from "./types.js";

const OPTION_KEYS = ["versions", "os"];
const KOTLIN = /\bkotlin\(\s*"|org\.jetbrains\.kotlin/;
const ANDROID = /com\.android\.(application|library)/;

function buildFiles(root: string): { file: string; text: string }[] {
  return GRADLE_FILES.flatMap((file) => {
    try {
      return [{ file, text: readFileSync(join(root, file), "utf8") }];
    } catch {
      return [];
    }
  });
}

/** Whether a Gradle build at the root applies a Kotlin plugin. */
export const usesKotlin = (root: string) => buildFiles(root).some(({ text }) => KOTLIN.test(text));

export const kotlinStack: StackPack = {
  id: "kotlin",
  detect: usesKotlin,
  async resolve(root, options = {}) {
    checkKeys("kotlin", options, OPTION_KEYS);
    const android = buildFiles(root).find(({ text }) => ANDROID.test(text));
    if (android) {
      throw new UsageError(
        `${android.file} is an Android project, which needs the Android SDK the CI runners don't have; leave kotlin out of stacks`,
      );
    }
    const { command, release, wrapper } = await gradleBuild(root);
    return {
      id: "kotlin",
      // ktlint or Spotless run through the build, like Spotless for java
      staged: [],
      test: command,
      install: null,
      gitignore: ["Kotlin", "Gradle"],
      dependabot: ["gradle"],
      ci: {
        workflow: "stack-java.yml",
        with: {
          "java-versions": JSON.stringify(stringList("kotlin", options, "versions") ?? ["17", "21"]),
          os: JSON.stringify(stringList("kotlin", options, "os") ?? ["ubuntu-latest"]),
          "build-tool": "gradle",
          "gradle-version": wrapper ? "" : "current",
          commands: JSON.stringify([command]),
        },
      },
      release,
    };
  },
};
```

Add `"kotlin"` to `STACK_IDS`, `kotlin: kotlinStack` to `PACKS`, `, kotlin` to the enum expectation in `test/config.test.ts`, and in `detectStacks` in `src/stacks/index.ts` drop java when kotlin is found:

```ts
export async function detectStacks(root: string): Promise<StackId[]> {
  let found = STACK_IDS.filter((id) => PACKS[id].detect(root));
  // a Kotlin build is also a Gradle build; one CI job runs it
  if (found.includes("kotlin")) found = found.filter((id) => id !== "java");
  // scripts beside another stack belong to that stack; the script pack is for script-only repositories
  return found.length > 1 ? found.filter((id) => id !== "script") : found;
}
```

- [ ] **Step 5: Add the gitignore template**

```bash
curl -fsSL https://raw.githubusercontent.com/github/gitignore/b06d69d5a0b82a187180dac3d46a4ebe1e40bce5/Kotlin.gitignore -o templates/gitignore/Kotlin.gitignore
```

- [ ] **Step 6: Add the fixture and its CI job**

`fixtures/kotlin/settings.gradle.kts`:

```kotlin
rootProject.name = "fixture"
```

`fixtures/kotlin/build.gradle.kts`:

```kotlin
plugins {
    kotlin("jvm") version "2.4.20"
}

repositories {
    mavenCentral()
}

dependencies {
    testImplementation(kotlin("test"))
}

kotlin {
    jvmToolchain(17)
}

tasks.test {
    useJUnitPlatform()
}
```

`fixtures/kotlin/gradle.properties`:

```
version=0.0.0
```

`fixtures/kotlin/src/main/kotlin/Greeter.kt`:

```kotlin
fun greet(name: String): String = "Hello, $name!"
```

`fixtures/kotlin/src/test/kotlin/GreeterTest.kt`:

```kotlin
import kotlin.test.Test
import kotlin.test.assertEquals

class GreeterTest {
    @Test
    fun greetsByName() {
        assertEquals("Hello, Ada!", greet("Ada"))
    }
}
```

Append to `.github/workflows/workflow-tests.yml` (no wrapper, so Gradle comes from `gradle-version: current`; `jvmToolchain(17)` means the job runs on Java 17 only):

```yaml
  kotlin:
    uses: ./.github/workflows/stack-java.yml
    with:
      working-directory: fixtures/kotlin
      os: '["ubuntu-latest"]'
      java-versions: '["17"]'
      build-tool: gradle
      gradle-version: current
      commands: '["gradle check"]'
```

In `test/workflows.test.ts` import `kotlinStack` and add `{ job: "kotlin", dir: "fixtures/kotlin", pack: kotlinStack }` to `FIXTURES` (`stack-java.yml` is already in `REUSABLE`).

- [ ] **Step 7: Run everything**

Run: `npx biome check --write . && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: PASS, including `test/stacks-java.test.ts` unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/stacks/gradle.ts src/stacks/kotlin.ts src/stacks/java.ts src/stacks/index.ts src/config/types.ts templates/gitignore/Kotlin.gitignore fixtures/kotlin .github/workflows/workflow-tests.yml test/stacks-kotlin.test.ts test/stacks.test.ts test/workflows.test.ts test/config.test.ts
git commit -m "feat(stacks): add the kotlin pack for Gradle builds, sharing the java workflow"
```

---

### Task 5: php stack

**Files:**
- Create: `src/stacks/php.ts`, `.github/workflows/stack-php.yml`, `templates/gitignore/Composer.gitignore`
- Create: `fixtures/php/composer.json`, `fixtures/php/phpunit.xml.dist`, `fixtures/php/src/Greeter.php`, `fixtures/php/tests/GreeterTest.php`, `fixtures/php/.gitignore`
- Modify: `src/config/types.ts`, `src/stacks/index.ts`, `.github/workflows/workflow-tests.yml`, `test/workflows.test.ts`, `test/config.test.ts`
- Test: `test/stacks-php.test.ts`

**Interfaces:**
- Consumes: `ReleaseType "php"` (Task 1), `checkKeys`, `stringList`, `readText`.
- Produces: `phpStack: StackPack` with id `"php"`; workflow `stack-php.yml` with inputs `php-versions`, `os`, `install-command`, `commands`, `working-directory`.

- [ ] **Step 1: Write the failing test**

Create `test/stacks-php.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { phpStack } from "../src/stacks/php.js";
import { tempDir } from "./helpers.js";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}
const composer = (extra: object = {}) => JSON.stringify({ name: "demo/app", ...extra });

it("is detected from composer.json", async () => {
  expect(phpStack.detect(await repo({ "composer.json": composer() }))).toBe(true);
  expect(phpStack.detect(await repo({ "index.php": "" }))).toBe(false);
});

it("validates composer.json, runs configured analysers and the test script", async () => {
  const stack = await phpStack.resolve(
    await repo({
      "composer.json": composer({ version: "2.1.0", scripts: { test: "phpunit" } }),
      "phpstan.neon": "",
      ".php-cs-fixer.dist.php": "",
    }),
  );
  expect(stack.ci).toEqual({
    workflow: "stack-php.yml",
    with: {
      "php-versions": '["8.3","8.4"]',
      os: '["ubuntu-latest"]',
      "install-command": "composer install --no-interaction --no-progress",
      commands: JSON.stringify([
        "composer validate --strict",
        "vendor/bin/php-cs-fixer fix --dry-run --diff",
        "vendor/bin/phpstan analyse --no-progress",
        "composer test",
      ]),
    },
  });
  expect(stack.staged).toEqual([
    { name: "php:cs-fixer", glob: "*.php", run: "vendor/bin/php-cs-fixer fix {staged_files}" },
  ]);
  expect(stack.test).toBe("composer test");
  expect(stack.install).toBe("composer install");
  expect(stack.gitignore).toEqual(["Composer"]);
  expect(stack.dependabot).toEqual(["composer"]);
  expect(stack.release).toEqual({ type: "php", version: "2.1.0" });
});

it("falls back to PHPUnit's config, and has no test command without one", async () => {
  const phpunit = await phpStack.resolve(await repo({ "composer.json": composer(), "phpunit.xml.dist": "" }));
  expect(phpunit.test).toBe("vendor/bin/phpunit");
  const bare = await phpStack.resolve(await repo({ "composer.json": composer() }));
  expect(bare.test).toBeNull();
  expect(bare.staged).toEqual([]);
  expect(JSON.parse(bare.ci?.with.commands ?? "")).toEqual(["composer validate --strict"]);
  expect(bare.release).toEqual({ type: "php", version: null });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/stacks-php.test.ts`
Expected: FAIL — cannot find module `../src/stacks/php.js`.

- [ ] **Step 3: Implement the pack and register it**

Create `src/stacks/php.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../errors.js";
import { checkKeys, readText, stringList } from "./support.js";
import type { StackPack } from "./types.js";

const OPTION_KEYS = ["versions", "os"];

interface Composer {
  version?: string;
  scripts?: Record<string, unknown>;
}

export const phpStack: StackPack = {
  id: "php",
  detect: (root) => existsSync(join(root, "composer.json")),
  async resolve(root, options = {}) {
    checkKeys("php", options, OPTION_KEYS);
    const has = (path: string) => existsSync(join(root, path));
    let composer: Composer;
    try {
      composer = JSON.parse((await readText(root, "composer.json")) ?? "{}") as Composer;
    } catch (error) {
      throw new UsageError(`composer.json could not be read: ${(error as Error).message}`);
    }
    const csFixer = has(".php-cs-fixer.dist.php") || has(".php-cs-fixer.php");
    const phpstan = has("phpstan.neon") || has("phpstan.neon.dist") || has("phpstan.dist.neon");
    const test = composer.scripts?.test
      ? "composer test"
      : has("phpunit.xml") || has("phpunit.xml.dist") || has("phpunit.dist.xml")
        ? "vendor/bin/phpunit"
        : null;
    return {
      id: "php",
      staged: csFixer ? [{ name: "php:cs-fixer", glob: "*.php", run: "vendor/bin/php-cs-fixer fix {staged_files}" }] : [],
      test,
      install: "composer install",
      gitignore: ["Composer"],
      dependabot: ["composer"],
      ci: {
        workflow: "stack-php.yml",
        with: {
          "php-versions": JSON.stringify(stringList("php", options, "versions") ?? ["8.3", "8.4"]),
          os: JSON.stringify(stringList("php", options, "os") ?? ["ubuntu-latest"]),
          "install-command": "composer install --no-interaction --no-progress",
          commands: JSON.stringify([
            "composer validate --strict",
            ...(csFixer ? ["vendor/bin/php-cs-fixer fix --dry-run --diff"] : []),
            ...(phpstan ? ["vendor/bin/phpstan analyse --no-progress"] : []),
            ...(test ? [test] : []),
          ]),
        },
      },
      release: { type: "php", version: composer.version ?? null },
    };
  },
};
```

Add `"php"` to `STACK_IDS`, `php: phpStack` to `PACKS`, `, php` to the enum expectation.

- [ ] **Step 4: Add the gitignore template**

```bash
curl -fsSL https://raw.githubusercontent.com/github/gitignore/b06d69d5a0b82a187180dac3d46a4ebe1e40bce5/Composer.gitignore -o templates/gitignore/Composer.gitignore
```

- [ ] **Step 5: Add the reusable workflow**

Create `.github/workflows/stack-php.yml`:

```yaml
name: stack-php

on:
  workflow_call:
    inputs:
      php-versions:
        description: JSON list of PHP versions
        type: string
        default: '["8.3","8.4"]'
      os:
        description: JSON list of runner labels
        type: string
        default: '["ubuntu-latest"]'
      install-command:
        description: Command that installs dependencies
        type: string
        default: composer install --no-interaction --no-progress
      commands:
        description: JSON list of shell commands run in order
        type: string
        default: '["composer validate --strict"]'
      working-directory:
        description: Directory holding composer.json
        type: string
        default: .

permissions:
  contents: read

jobs:
  php:
    name: php ${{ matrix.php }} (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: ${{ fromJSON(inputs.os) }}
        php: ${{ fromJSON(inputs.php-versions) }}
    runs-on: ${{ matrix.os }}
    permissions:
      contents: read
    defaults:
      run:
        shell: bash
        working-directory: ${{ inputs.working-directory }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: shivammathur/setup-php@f3e473d116dcccaddc5834248c87452386958240 # 2.37.2
        with:
          php-version: ${{ matrix.php }}
          tools: composer
          coverage: none
      - name: Install dependencies
        env:
          INSTALL: ${{ inputs.install-command }}
        run: bash -c "$INSTALL"
      - name: Run checks
        env:
          COMMANDS: ${{ inputs.commands }}
        run: |
          node -e 'for (const c of JSON.parse(process.env.COMMANDS)) console.log(c)' | while IFS= read -r command; do
            echo "::group::$command"
            bash -c "$command" </dev/null
            echo "::endgroup::"
          done
```

- [ ] **Step 6: Add the fixture and its CI job**

`fixtures/php/composer.json` (PHPUnit 12 supports PHP 8.3, which the default matrix starts at):

```json
{
  "name": "vannt-dev/fixture-php",
  "description": "Fixture for the stack-php workflow.",
  "type": "library",
  "license": "MIT",
  "require": {
    "php": ">=8.3"
  },
  "require-dev": {
    "phpunit/phpunit": "^12.0"
  },
  "autoload": {
    "psr-4": { "Fixture\\": "src/" }
  },
  "scripts": {
    "test": "phpunit"
  }
}
```

`fixtures/php/phpunit.xml.dist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<phpunit bootstrap="vendor/autoload.php" colors="true">
  <testsuites>
    <testsuite name="fixture">
      <directory>tests</directory>
    </testsuite>
  </testsuites>
</phpunit>
```

`fixtures/php/src/Greeter.php`:

```php
<?php

declare(strict_types=1);

namespace Fixture;

final class Greeter
{
    public static function greet(string $name): string
    {
        return "Hello, {$name}!";
    }
}
```

`fixtures/php/tests/GreeterTest.php`:

```php
<?php

declare(strict_types=1);

use Fixture\Greeter;
use PHPUnit\Framework\TestCase;

final class GreeterTest extends TestCase
{
    public function testGreetsByName(): void
    {
        self::assertSame('Hello, Ada!', Greeter::greet('Ada'));
    }
}
```

`fixtures/php/.gitignore`:

```
vendor/
composer.lock
```

Append to `.github/workflows/workflow-tests.yml`:

```yaml
  php:
    uses: ./.github/workflows/stack-php.yml
    with:
      working-directory: fixtures/php
      os: '["ubuntu-latest"]'
      php-versions: '["8.3","8.4"]'
      install-command: composer install --no-interaction --no-progress
      commands: '["composer validate --strict","composer test"]'
```

`composer validate --strict` warns when `composer.lock` is missing only if it exists but is outdated; without a lock file it passes. In `test/workflows.test.ts` add `"stack-php.yml"` to `REUSABLE`, import `phpStack`, and add `{ job: "php", dir: "fixtures/php", pack: phpStack }` to `FIXTURES`.

- [ ] **Step 7: Run everything**

Run: `npx biome check --write . && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/stacks/php.ts src/stacks/index.ts src/config/types.ts .github/workflows/stack-php.yml .github/workflows/workflow-tests.yml templates/gitignore/Composer.gitignore fixtures/php test/stacks-php.test.ts test/workflows.test.ts test/config.test.ts
git commit -m "feat(stacks): add the php pack with composer, php-cs-fixer, PHPStan and PHPUnit"
```

---

### Task 6: ruby stack

**Files:**
- Create: `src/stacks/ruby.ts`, `.github/workflows/stack-ruby.yml`, `templates/gitignore/Ruby.gitignore`
- Create: `fixtures/ruby/Gemfile`, `fixtures/ruby/Rakefile`, `fixtures/ruby/lib/fixture.rb`, `fixtures/ruby/lib/fixture/version.rb`, `fixtures/ruby/test/fixture_test.rb`, `fixtures/ruby/.gitignore`
- Modify: `src/config/types.ts`, `src/stacks/index.ts`, `.github/workflows/workflow-tests.yml`, `test/workflows.test.ts`, `test/config.test.ts`
- Test: `test/stacks-ruby.test.ts`

**Interfaces:**
- Consumes: `ReleaseType "ruby"` and `ReleaseInfo.versionFile` (Task 1), `checkKeys`, `stringList`, `readText`, `filesMatching`.
- Produces: `rubyStack: StackPack` with id `"ruby"`; workflow `stack-ruby.yml` with inputs `ruby-versions`, `os`, `install-command`, `commands`, `working-directory`.

- [ ] **Step 1: Write the failing test**

Create `test/stacks-ruby.test.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { rubyStack } from "../src/stacks/ruby.js";
import { tempDir } from "./helpers.js";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

it("is detected from a Gemfile", async () => {
  expect(rubyStack.detect(await repo({ Gemfile: 'source "https://rubygems.org"\n' }))).toBe(true);
  expect(rubyStack.detect(await repo({ "app.rb": "" }))).toBe(false);
});

it("runs RuboCop when configured and RSpec, and releases lib/<gem>/version.rb", async () => {
  const stack = await rubyStack.resolve(
    await repo({
      Gemfile: "",
      ".rubocop.yml": "",
      "spec/demo_spec.rb": "",
      "lib/demo/version.rb": 'module Demo\n  VERSION = "0.5.0"\nend\n',
    }),
  );
  expect(stack.ci).toEqual({
    workflow: "stack-ruby.yml",
    with: {
      "ruby-versions": '["3.3","3.4"]',
      os: '["ubuntu-latest"]',
      "install-command": "bundle install",
      commands: JSON.stringify(["bundle exec rubocop", "bundle exec rspec"]),
    },
  });
  expect(stack.staged).toEqual([
    { name: "ruby:rubocop", glob: "*.rb", run: "bundle exec rubocop --autocorrect {staged_files}" },
  ]);
  expect(stack.test).toBe("bundle exec rspec");
  expect(stack.install).toBe("bundle install");
  expect(stack.gitignore).toEqual(["Ruby"]);
  expect(stack.dependabot).toEqual(["bundler"]);
  expect(stack.release).toEqual({ type: "ruby", version: "0.5.0", versionFile: "lib/demo/version.rb" });
});

it("runs minitest through rake, and reads a version kept only in the gemspec", async () => {
  const stack = await rubyStack.resolve(
    await repo({
      Gemfile: "",
      Rakefile: "",
      "test/demo_test.rb": "",
      "demo.gemspec": 'Gem::Specification.new do |s|\n  s.version = "1.1.0"\nend\n',
    }),
  );
  expect(stack.test).toBe("bundle exec rake test");
  expect(stack.staged).toEqual([]);
  expect(stack.release).toEqual({ type: "ruby", version: "1.1.0" });
});

it("has no test command without specs or a Rakefile", async () => {
  const stack = await rubyStack.resolve(await repo({ Gemfile: "" }));
  expect(stack.test).toBeNull();
  expect(JSON.parse(stack.ci?.with.commands ?? "")).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/stacks-ruby.test.ts`
Expected: FAIL — cannot find module `../src/stacks/ruby.js`.

- [ ] **Step 3: Implement the pack and register it**

Create `src/stacks/ruby.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseInfo } from "../model.js";
import { checkKeys, filesMatching, readText, stringList } from "./support.js";
import type { StackPack } from "./types.js";

const OPTION_KEYS = ["versions", "os"];
const QUOTED_VERSION = /version\s*=\s*["']([^"']+)["']/i;

/** A `VERSION = "x.y.z"` in lib/<name>/version.rb, else the gemspec's `version = "x.y.z"`. */
async function rubyRelease(root: string): Promise<ReleaseInfo> {
  for (const dir of filesMatching(root, "lib", /^[^.]+$/)) {
    const path = `lib/${dir}/version.rb`;
    const version = QUOTED_VERSION.exec((await readText(root, path)) ?? "")?.[1];
    if (version) return { type: "ruby", version, versionFile: path };
  }
  for (const spec of filesMatching(root, ".", /\.gemspec$/)) {
    const version = QUOTED_VERSION.exec((await readText(root, spec)) ?? "")?.[1];
    if (version) return { type: "ruby", version };
  }
  return { type: "ruby", version: null };
}

export const rubyStack: StackPack = {
  id: "ruby",
  detect: (root) => existsSync(join(root, "Gemfile")),
  async resolve(root, options = {}) {
    checkKeys("ruby", options, OPTION_KEYS);
    const has = (path: string) => existsSync(join(root, path));
    const rubocop = has(".rubocop.yml");
    const test = has("spec") ? "bundle exec rspec" : has("Rakefile") && has("test") ? "bundle exec rake test" : null;
    return {
      id: "ruby",
      staged: rubocop
        ? [{ name: "ruby:rubocop", glob: "*.rb", run: "bundle exec rubocop --autocorrect {staged_files}" }]
        : [],
      test,
      install: "bundle install",
      gitignore: ["Ruby"],
      dependabot: ["bundler"],
      ci: {
        workflow: "stack-ruby.yml",
        with: {
          "ruby-versions": JSON.stringify(stringList("ruby", options, "versions") ?? ["3.3", "3.4"]),
          os: JSON.stringify(stringList("ruby", options, "os") ?? ["ubuntu-latest"]),
          "install-command": "bundle install",
          commands: JSON.stringify([...(rubocop ? ["bundle exec rubocop"] : []), ...(test ? [test] : [])]),
        },
      },
      release: await rubyRelease(root),
    };
  },
};
```

`filesMatching(root, "lib", /^[^.]+$/)` lists directory names under `lib/` (entries without a dot), sorted. Add `"ruby"` to `STACK_IDS`, `ruby: rubyStack` to `PACKS`, and `, ruby` to the enum expectation.

- [ ] **Step 4: Add the gitignore template**

```bash
curl -fsSL https://raw.githubusercontent.com/github/gitignore/b06d69d5a0b82a187180dac3d46a4ebe1e40bce5/Ruby.gitignore -o templates/gitignore/Ruby.gitignore
```

- [ ] **Step 5: Add the reusable workflow**

Create `.github/workflows/stack-ruby.yml`:

```yaml
name: stack-ruby

on:
  workflow_call:
    inputs:
      ruby-versions:
        description: JSON list of Ruby versions
        type: string
        default: '["3.3","3.4"]'
      os:
        description: JSON list of runner labels
        type: string
        default: '["ubuntu-latest"]'
      install-command:
        description: Command that installs dependencies
        type: string
        default: bundle install
      commands:
        description: JSON list of shell commands run in order
        type: string
        default: "[]"
      working-directory:
        description: Directory holding the Gemfile
        type: string
        default: .

permissions:
  contents: read

jobs:
  ruby:
    name: ruby ${{ matrix.ruby }} (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: ${{ fromJSON(inputs.os) }}
        ruby: ${{ fromJSON(inputs.ruby-versions) }}
    runs-on: ${{ matrix.os }}
    permissions:
      contents: read
    defaults:
      run:
        shell: bash
        working-directory: ${{ inputs.working-directory }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: ruby/setup-ruby@14594264cd68ce8a2345dd349bc3d138a4ef85c8 # v1.327.0
        with:
          ruby-version: ${{ matrix.ruby }}
          working-directory: ${{ inputs.working-directory }}
      - name: Install dependencies
        env:
          INSTALL: ${{ inputs.install-command }}
        run: bash -c "$INSTALL"
      - name: Run checks
        env:
          COMMANDS: ${{ inputs.commands }}
        run: |
          node -e 'for (const c of JSON.parse(process.env.COMMANDS)) console.log(c)' | while IFS= read -r command; do
            echo "::group::$command"
            bash -c "$command" </dev/null
            echo "::endgroup::"
          done
```

- [ ] **Step 6: Add the fixture and its CI job**

`fixtures/ruby/Gemfile`:

```ruby
source "https://rubygems.org"

gem "minitest", "~> 6.0"
gem "rake", "~> 13.4"
```

`fixtures/ruby/Rakefile`:

```ruby
require "rake/testtask"

Rake::TestTask.new(:test) do |t|
  t.libs << "lib" << "test"
  t.pattern = "test/**/*_test.rb"
end

task default: :test
```

`fixtures/ruby/lib/fixture.rb`:

```ruby
require_relative "fixture/version"

module Fixture
  def self.greet(name)
    "Hello, #{name}!"
  end
end
```

`fixtures/ruby/lib/fixture/version.rb`:

```ruby
module Fixture
  VERSION = "0.0.0"
end
```

`fixtures/ruby/test/fixture_test.rb`:

```ruby
require "minitest/autorun"
require "fixture"

class FixtureTest < Minitest::Test
  def test_greets_by_name
    assert_equal "Hello, Ada!", Fixture.greet("Ada")
  end
end
```

`fixtures/ruby/.gitignore`:

```
Gemfile.lock
```

Append to `.github/workflows/workflow-tests.yml`:

```yaml
  ruby:
    uses: ./.github/workflows/stack-ruby.yml
    with:
      working-directory: fixtures/ruby
      os: '["ubuntu-latest"]'
      ruby-versions: '["3.3","3.4"]'
      install-command: bundle install
      commands: '["bundle exec rake test"]'
```

In `test/workflows.test.ts` add `"stack-ruby.yml"` to `REUSABLE`, import `rubyStack`, and add `{ job: "ruby", dir: "fixtures/ruby", pack: rubyStack }` to `FIXTURES`.

- [ ] **Step 7: Run everything**

Run: `npx biome check --write . && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/stacks/ruby.ts src/stacks/index.ts src/config/types.ts .github/workflows/stack-ruby.yml .github/workflows/workflow-tests.yml templates/gitignore/Ruby.gitignore fixtures/ruby test/stacks-ruby.test.ts test/workflows.test.ts test/config.test.ts
git commit -m "feat(stacks): add the ruby pack with RuboCop, RSpec or minitest"
```

---

### Task 7: Standard 1.3.0, an end-to-end init per new stack, and the docs

**Files:**
- Modify: `src/version.ts` (`STANDARD_VERSION`)
- Modify: `test/e2e.test.ts`
- Modify: `README.md` (the stack list near the top), `docs/superpowers/specs/2026-09-25-repokeeper-design.md` (the stack tables in section 5 and the delivery order in section 12)
- Modify: `.repokeeper.yml`, `.repokeeper/lock.json` (via `repokeeper update` on this repository)

**Interfaces:**
- Consumes: all five packs from Tasks 2–6.

- [ ] **Step 1: Write the failing end-to-end test**

Add to the `describe("repokeeper end to end", …)` block in `test/e2e.test.ts`:

```ts
  it.each([
    ["go", { "go.mod": "module example.com/demo\n\ngo 1.22\n" }, "stack-go.yml", "## Go (github/gitignore)"],
    ["rust", { "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n' }, "stack-rust.yml", "## Rust (github/gitignore)"],
    ["kotlin", { "build.gradle.kts": 'plugins {\n    kotlin("jvm") version "2.4.20"\n}\n' }, "stack-java.yml", "## Kotlin (github/gitignore)"],
    ["php", { "composer.json": '{ "name": "demo/app" }\n' }, "stack-php.yml", "## Composer (github/gitignore)"],
    ["ruby", { Gemfile: 'source "https://rubygems.org"\n' }, "stack-ruby.yml", "## Ruby (github/gitignore)"],
  ])("applies the standard to a %s repository", async (stack, files, workflow, gitignore) => {
    const dir = await tempDir();
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.name", "Demo User");
    sh(dir, "config", "user.email", "demo@example.com");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "chore: initial");

    expect((await repokeeper(dir, "init")).code).toBe(0);
    expect(parse(await readFile(join(dir, ".repokeeper.yml"), "utf8")).stacks).toEqual([stack]);
    const ci = parse(await readFile(join(dir, ".github/workflows/ci.yml"), "utf8"));
    expect(ci.jobs[stack].uses).toContain(`/${workflow}@v`);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain(gitignore);
    commitAll(dir);
    expect((await repokeeper(dir, "check")).code).toBe(0);
  });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/e2e.test.ts -t "applies the standard to a"`
Expected: PASS for all five if Tasks 2–6 are done; any failure points at the pack to fix before moving on.

- [ ] **Step 3: Move the standard and resync this repository**

In `src/version.ts` set `export const STANDARD_VERSION = "1.3.0";`. Then:

```bash
npm run build && node dist/cli.js update && node dist/cli.js check
```

Expected: `repository is on standard 1.3.0` and then `repository matches the standard`.

- [ ] **Step 4: Update the docs**

In `README.md`, replace the stack list line near the top (currently ending "…Java (Maven and Gradle) and .NET, each with CI and releases.") with:

```markdown
> Flutter, shell and PowerShell scripts, Java (Maven and Gradle), Kotlin, .NET, Go, Rust, PHP and Ruby, each with CI and releases.
```

and keep the lines before it unchanged (read the first 10 lines first; the list starts on the line above).

In the spec, add these rows to the first stack table in section 5 (after `dotnet`):

```markdown
| go | `go.mod` | `gofmt`, `go vet` | `go test ./...` | Go stable |
| rust | `Cargo.toml` | `cargo fmt --check`, `cargo clippy -D warnings` | `cargo test` | Rust stable |
| kotlin | a Gradle build applying a Kotlin plugin (takes precedence over java; Android is refused) | ktlint or Spotless through the build | `./gradlew check` | Temurin 17, 21 |
| php | `composer.json` | `composer validate --strict`, php-cs-fixer and PHPStan when configured | `composer test`, else PHPUnit when configured | PHP 8.3, 8.4 |
| ruby | `Gemfile` | RuboCop when configured | RSpec, else `rake test` for minitest | Ruby 3.3, 3.4 |
```

and to the release/gitignore/Dependabot table:

```markdown
| go | `go` (version from tags) | `Go` | `gomod` |
| rust | `rust`; `simple` for a workspace root without a package | `Rust` | `cargo` |
| kotlin | `simple` with `gradle.properties` as an extra file | `Kotlin`, `Gradle` | `gradle` |
| php | `php` | `Composer` | `composer` |
| ruby | `ruby` with `lib/<gem>/version.rb` as `version-file` | `Ruby` | `bundler` |
```

In section 12, change item 6 to read: "Phase 2: go, rust, kotlin, php and ruby packs (done in 0.4.0); a GitLab adapter (GitLab CI components, Renovate, semantic-release, protected branches and approvals)."

- [ ] **Step 5: Run the full prepublish chain**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/version.ts test/e2e.test.ts .repokeeper.yml .repokeeper/lock.json README.md docs/superpowers/specs/2026-09-25-repokeeper-design.md
git commit -m "feat: move the standard to 1.3.0 with the go, rust, kotlin, php and ruby packs"
```

---

### Task 8: Pull request, pilots and release 0.4.0 (owner-gated release)

**Files:** none in this repository beyond what Tasks 1–7 changed.

- [ ] **Step 1: Open the pull request and watch CI**

```bash
git push -u origin feat/more-stacks
cat > "$TEMP/pr-body.md" <<'EOF'
Phase 2, part 1 (plan: docs/superpowers/plans/2026-09-27-repokeeper-more-stacks.md).

- New stack packs: go (gofmt, go vet, go test), rust (rustfmt, clippy -D warnings, cargo test),
  kotlin (Gradle through stack-java.yml; takes precedence over java; Android refused),
  php (composer validate, php-cs-fixer/PHPStan when configured, composer test or PHPUnit),
  ruby (RuboCop when configured, RSpec or rake test).
- Reusable workflows stack-go/rust/php/ruby.yml, each exercised by a fixture in workflow-tests.
- release-please types go, rust, php and ruby, and version-file for ruby's version.rb.
- Standard 1.3.0.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
gh pr create --base main --title "feat: go, rust, kotlin, php and ruby stack packs" --body-file "$TEMP/pr-body.md"
gh pr checks --watch
```

Expected: every check green, including the new `workflow-tests` jobs `go`, `rust`, `kotlin`, `php` and `ruby`. A red fixture job means the pack's commands or the workflow are wrong; fix the pack and the fixture job together (the workflows test keeps them equal).

- [ ] **Step 2: Merge the pull request** (the owner has asked Claude to merge feature pull requests)

```bash
gh pr merge --squash --delete-branch
```

- [ ] **Step 3: Pilot each pack on a demo repository**

For each of `go`, `rust`, `kotlin`, `php`, `ruby`, create `vannt-dev/repokeeper-demo-<id>` (public, like the existing .NET and Dart demos) holding the matching fixture's files as its first commit, then:

```bash
git switch -c chore/repokeeper
# 0.4.0 is not on npm yet, so run the build of merged main (npm run build in the repokeeper checkout first)
node F:/ai-agent/repokeeper/dist/cli.js init
git add -A && git commit -m "chore(repokeeper): apply standard 1.3.0"
git push -u origin chore/repokeeper && gh pr create --fill && gh pr checks --watch
```

Expected: green CI on each; merge them. Record anything done by hand as a repokeeper issue.

- [ ] **Step 4: Release (owner)**

release-please opens `chore(main): release 0.4.0`. The owner merges it (Claude may not merge release pull requests: publishing is blocked for it). Then verify:

```bash
curl -s https://registry.npmjs.org/repokeeper | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j['dist-tags'].latest, !!j.versions['0.4.0']?.dist?.attestations)})"
git ls-remote --tags origin v0
```

Expected: `0.4.0 true`, and `v0` at the `v0.4.0` commit.
