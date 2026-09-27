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
  const stack = await goStack.resolve(await repo({ "go.mod": "module a\n" }), {
    versions: ["1.23", "1.24"],
    os: ["windows-latest"],
  });
  expect(stack.ci?.with).toMatchObject({ "go-versions": '["1.23","1.24"]', os: '["windows-latest"]' });
  await expect(goStack.resolve(await repo({ "go.mod": "module a\n" }), { lint: true })).rejects.toThrow(
    "stack_options.go.lint is not a known key",
  );
});
