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
  expect(stack.release).toEqual({ type: "ruby", version: "1.1.0", extraFiles: ["demo.gemspec"] });
});

it("has no test command without specs or a Rakefile", async () => {
  const stack = await rubyStack.resolve(await repo({ Gemfile: "" }));
  expect(stack.test).toBeNull();
  expect(JSON.parse(stack.ci?.with.commands ?? "")).toEqual([]);
});

it("reads only the gem's own version, not required_ruby_version or other constants", async () => {
  const computed = await rubyStack.resolve(
    await repo({
      Gemfile: "",
      "demo.gemspec":
        'Gem::Specification.new do |s|\n  s.version = File.read("VERSION").strip\n  s.required_ruby_version = ">= 3.1"\nend\n',
    }),
  );
  expect(computed.release).toEqual({ type: "ruby", version: null });
  const constants = await rubyStack.resolve(
    await repo({
      Gemfile: "",
      "lib/demo/version.rb": 'module Demo\n  MINIMUM_RUBY_VERSION = "3.0"\n  VERSION = "2.0.0"\nend\n',
    }),
  );
  expect(constants.release).toEqual({ type: "ruby", version: "2.0.0", versionFile: "lib/demo/version.rb" });
});
