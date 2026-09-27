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
      staged: csFixer
        ? [{ name: "php:cs-fixer", glob: "*.php", run: "vendor/bin/php-cs-fixer fix {staged_files}" }]
        : [],
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
            // --strict would fail on warnings such as a missing license or the version field release-please writes
            "composer validate --no-check-publish",
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
