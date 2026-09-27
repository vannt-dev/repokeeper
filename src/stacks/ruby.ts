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
