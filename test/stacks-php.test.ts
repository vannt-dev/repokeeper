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
