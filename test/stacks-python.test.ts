import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pythonStack } from "../src/stacks/python.js";
import { tempDir } from "./helpers.js";

async function repo(files: Record<string, string>, dirs: string[] = []): Promise<string> {
  const dir = await tempDir();
  for (const d of dirs) await mkdir(join(dir, d), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}
const PYPROJECT = '[project]\nname = "demo"\nversion = "0.4.0"\n\n[tool.ruff]\nline-length = 100\n';

it("is detected from pyproject.toml, requirements.txt or setup.cfg", async () => {
  expect(pythonStack.detect(await repo({ "pyproject.toml": PYPROJECT }))).toBe(true);
  expect(pythonStack.detect(await repo({ "requirements.txt": "" }))).toBe(true);
  expect(pythonStack.detect(await repo({ "setup.cfg": "" }))).toBe(true);
  expect(pythonStack.detect(await repo({ "main.py": "" }))).toBe(false);
});

it("installs with pip, checks with ruff and runs pytest when there are tests", async () => {
  const stack = await pythonStack.resolve(
    await repo({ "pyproject.toml": PYPROJECT, "requirements-dev.txt": "" }, ["tests"]),
  );
  expect(stack.ci).toEqual({
    workflow: "stack-python.yml",
    with: {
      "python-versions": '["3.11","3.12","3.13"]',
      os: '["ubuntu-latest"]',
      manager: "pip",
      "install-command":
        "python -m pip install -r requirements-dev.txt && python -m pip install -e . && python -m pip install ruff pytest",
      commands: '["ruff format --check .","ruff check .","python -m pytest"]',
    },
  });
  expect(stack.staged.map((j) => j.run)).toEqual(["ruff format {staged_files}", "ruff check --fix {staged_files}"]);
  expect(stack.test).toBe("python -m pytest");
  expect(stack.install).toBe("python -m pip install -r requirements-dev.txt && python -m pip install -e .");
  expect(stack.release).toEqual({ type: "python", version: "0.4.0" });
  expect(stack.gitignore).toEqual(["Python"]);
  expect(stack.dependabot).toEqual(["pip"]);
});

it("adds mypy when it is configured and leaves pytest out without tests", async () => {
  const stack = await pythonStack.resolve(await repo({ "requirements.txt": "", "mypy.ini": "" }));
  expect(JSON.parse(stack.ci?.with.commands ?? "")).toEqual(["ruff format --check .", "ruff check .", "mypy ."]);
  expect(stack.ci?.with["install-command"]).toBe(
    "python -m pip install -r requirements.txt && python -m pip install ruff mypy",
  );
  expect(stack.test).toBeNull();
  expect(stack.release.version).toBeNull();
});

it("lets mypy pick its own files when the config names them", async () => {
  const commands = async (files: Record<string, string>) =>
    JSON.parse((await pythonStack.resolve(await repo(files))).ci?.with.commands ?? "");
  expect(await commands({ "pyproject.toml": `${PYPROJECT}\n[tool.mypy]\nfiles = ["src", "hooks"]\n` })).toContain(
    "mypy",
  );
  expect(await commands({ "requirements.txt": "", "mypy.ini": "[mypy]\nfiles = src\n" })).toContain("mypy");
  expect(await commands({ "requirements.txt": "", "mypy.ini": "[mypy]\nstrict = True\n" })).toContain("mypy .");
});

it("runs everything through uv when the project has uv.lock", async () => {
  const stack = await pythonStack.resolve(
    await repo({ "pyproject.toml": `${PYPROJECT}\n[tool.mypy]\nstrict = true\n`, "uv.lock": "" }, ["tests"]),
  );
  expect(stack.ci?.with).toMatchObject({
    manager: "uv",
    "install-command": "uv sync --frozen && uv pip install ruff mypy pytest",
    commands: '["uv run ruff format --check .","uv run ruff check .","uv run mypy .","uv run pytest"]',
  });
  expect(stack.staged.map((j) => j.run)).toEqual([
    "uvx ruff format {staged_files}",
    "uvx ruff check --fix {staged_files}",
  ]);
  expect(stack.test).toBe("uv run pytest");
  expect(stack.install).toBe("uv sync");
  expect(stack.dependabot).toEqual(["uv"]);
});

it("takes versions, os and a test command from stack options", async () => {
  const stack = await pythonStack.resolve(await repo({ "requirements.txt": "" }), {
    versions: ["3.12"],
    os: ["windows-latest"],
    test: "python -m unittest",
  });
  expect(stack.ci?.with).toMatchObject({
    "python-versions": '["3.12"]',
    os: '["windows-latest"]',
    commands: '["ruff format --check .","ruff check .","python -m unittest"]',
  });
  expect(stack.test).toBe("python -m unittest");
});
