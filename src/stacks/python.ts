import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StagedJob } from "../model.js";
import { checkKeys, filesMatching, optionalString, readText, stringList, tomlSection } from "./support.js";
import type { StackPack } from "./types.js";

const OPTION_KEYS = ["versions", "os", "test"];

/** The `version = "…"` of the `[project]` table, if any. */
function projectVersion(pyproject: string): string | null {
  return /^version\s*=\s*"([^"]+)"/m.exec(tomlSection(pyproject, "project"))?.[1] ?? null;
}

export const pythonStack: StackPack = {
  id: "python",
  detect: (root) => ["pyproject.toml", "requirements.txt", "setup.cfg"].some((f) => existsSync(join(root, f))),
  async resolve(root, options = {}) {
    checkKeys("python", options, OPTION_KEYS);
    const has = (path: string) => existsSync(join(root, path));
    const pyproject = (await readText(root, "pyproject.toml")) ?? "";
    const uv = has("uv.lock");
    const mypyIni = (await readText(root, "mypy.ini")) ?? "";
    const mypy = has("mypy.ini") || pyproject.includes("[tool.mypy]");
    // a config that names its files decides what mypy checks; otherwise check the whole tree
    const mypyFiles = /^files\s*=/m.test(mypyIni) || /^files\s*=/m.test(tomlSection(pyproject, "tool.mypy"));
    const hasTests = has("tests") || has("test") || filesMatching(root, ".", /^test_.*\.py$/).length > 0;
    const customTest = optionalString("python", options, "test");
    const pytest = customTest === undefined && hasTests;
    const tools = ["ruff", ...(mypy ? ["mypy"] : []), ...(pytest ? ["pytest"] : [])];
    const run = uv ? "uv run " : "";

    const projectInstall: string[] = [];
    if (!uv) {
      if (has("requirements.txt")) projectInstall.push("python -m pip install -r requirements.txt");
      if (has("requirements-dev.txt")) projectInstall.push("python -m pip install -r requirements-dev.txt");
      if (/^\[project\]/m.test(pyproject)) projectInstall.push("python -m pip install -e .");
    }
    const ciInstall = uv
      ? `uv sync --frozen && uv pip install ${tools.join(" ")}`
      : [...projectInstall, `python -m pip install ${tools.join(" ")}`].join(" && ");
    const test = customTest ?? (pytest ? (uv ? "uv run pytest" : "python -m pytest") : null);
    const commands = [
      `${run}ruff format --check .`,
      `${run}ruff check .`,
      ...(mypy ? [`${run}mypy${mypyFiles ? "" : " ."}`] : []),
      ...(test ? [test] : []),
    ];
    const ruff = uv ? "uvx ruff" : "ruff";
    const staged: StagedJob[] = [
      { name: "python:ruff-format", glob: "*.py", run: `${ruff} format {staged_files}` },
      { name: "python:ruff-check", glob: "*.py", run: `${ruff} check --fix {staged_files}` },
    ];
    return {
      id: "python",
      staged,
      test,
      install: uv ? "uv sync" : projectInstall.length > 0 ? projectInstall.join(" && ") : null,
      gitignore: ["Python"],
      dependabot: [uv ? "uv" : "pip"],
      ci: {
        workflow: "stack-python.yml",
        with: {
          "python-versions": JSON.stringify(stringList("python", options, "versions") ?? ["3.11", "3.12", "3.13"]),
          os: JSON.stringify(stringList("python", options, "os") ?? ["ubuntu-latest"]),
          manager: uv ? "uv" : "pip",
          "install-command": ciInstall,
          commands: JSON.stringify(commands),
        },
      },
      release: { type: "python", version: projectVersion(pyproject) },
    };
  },
};
