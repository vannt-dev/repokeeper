import { execFileSync } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { run } from "../src/cli.js";
import { MANAGED_IMAGES } from "../src/platforms/gitlab.js";
import { SCRIPT_ANALYZER_VERSION, SHFMT_VERSION } from "../src/platforms/gitlab-jobs.js";
import { PACKAGE_VERSION, TOOL_VERSIONS } from "../src/version.js";
import { capture, tempDir } from "./helpers.js";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const workflows = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const FOR_CHANGES = [
  {
    if: '$CI_PIPELINE_SOURCE != "schedule" && $CI_COMMIT_TAG == null && ($CI_COMMIT_BRANCH == null || $CI_COMMIT_MESSAGE !~ /^chore\\(release\\): /)',
  },
];

interface Job {
  stage: string;
  image: string;
  parallel?: { matrix: Array<Record<string, string[]>> };
  rules: unknown;
  variables?: Record<string, string>;
  script: string[];
}

/** A fixture as a repository on GitLab with the standard applied: its CI file and its release configuration. */
async function onGitlab(fixture: string, files: Record<string, string> = {}, options = "") {
  const dir = await tempDir();
  await cp(join(fixtures, fixture), dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Demo User");
  git("config", "user.email", "demo@example.com");
  git("config", "core.autocrlf", "false");
  git("remote", "add", "origin", "git@gitlab.com:acme/demo.git");
  git("add", "-A");
  git("commit", "-qm", "chore: initial");
  const c = capture(dir);
  expect(await run(["init"], c.io), c.err.join("\n")).toBe(0);
  if (options) {
    const config = await readFile(join(dir, ".repokeeper.yml"), "utf8");
    await writeFile(join(dir, ".repokeeper.yml"), config.replace("stack_options: {}", `stack_options:\n${options}`));
    git("add", "-A");
    git("commit", "-qm", "chore: sync");
    const update = capture(dir);
    expect(await run(["update"], update.io), update.err.join("\n")).toBe(0);
  }
  const ci = parse(await readFile(join(dir, ".gitlab-ci.yml"), "utf8")) as Record<string, Job>;
  const release = JSON.parse(await readFile(join(dir, ".releaserc.json"), "utf8")) as {
    plugins: Array<string | [string, Record<string, unknown>]>;
  };
  const plugin = (name: string) =>
    release.plugins.find(
      (entry): entry is [string, Record<string, unknown>] => Array.isArray(entry) && entry[0] === name,
    )?.[1];
  return { dir, ci, out: c.out.join("\n"), plugin, releaseScript: (ci.release as Job).script.join("\n") };
}

/** What a release of a stack with version files does: repokeeper writes the version, the release commits the files. */
function expectBump(project: Awaited<ReturnType<typeof onGitlab>>, files: string[]) {
  expect(project.plugin("@semantic-release/exec")).toEqual({
    prepareCmd: `npx --yes repokeeper@${PACKAGE_VERSION} bump \${nextRelease.version}`,
  });
  expect(project.plugin("@semantic-release/npm")).toBeUndefined();
  expect(project.plugin("@semantic-release/git")?.assets).toEqual(["CHANGELOG.md", ...files]);
  expect(project.releaseScript).toContain(`@semantic-release/exec@${TOOL_VERSIONS.semanticReleaseExec}`);
}

/** Every fixture: each stack, and the second package manager or build tool of the ones that have two. */
const FIXTURES = [
  "node",
  "node-pnpm",
  "go",
  "python",
  "rust",
  "ruby",
  "php",
  "dart",
  "java-gradle",
  "java-maven",
  "kotlin",
  "dotnet",
  "script",
] as const;

describe("gitlab ci for the other stacks", () => {
  it("python: one job per version, pip or uv", async () => {
    const pip = await onGitlab("python");
    expect(Object.keys(pip.ci)).toEqual(["workflow", "python", "commits", "renovate", "release"]);
    expect(pip.ci.python).toEqual({
      stage: "test",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
      image: "python:${PYTHON_VERSION}",
      parallel: { matrix: [{ PYTHON_VERSION: ["3.11", "3.12", "3.13"] }] },
      rules: FOR_CHANGES,
      variables: { PIP_ROOT_USER_ACTION: "ignore" },
      script: [
        "python -m pip install -e . && python -m pip install ruff pytest",
        "ruff format --check .",
        "ruff check .",
        "python -m pytest",
      ],
    });
    expectBump(pip, ["pyproject.toml", "setup.cfg", "setup.py"]);

    const uv = await onGitlab("python", { "uv.lock": "version = 1\n" }, '  python:\n    versions: ["3.13"]');
    expect(uv.ci.python?.parallel).toEqual({ matrix: [{ PYTHON_VERSION: ["3.13"] }] });
    expect(uv.ci.python?.variables).toEqual({ PIP_ROOT_USER_ACTION: "ignore", UV_PYTHON: "$PYTHON_VERSION" });
    expect(uv.ci.python?.script.slice(0, 3)).toEqual([
      "python -m pip install uv",
      "uv sync --frozen && uv pip install ruff pytest",
      "uv run ruff format --check .",
    ]);
  });

  it("rust: installs the named toolchain with rustfmt and clippy, as on GitHub", async () => {
    const rust = await onGitlab("rust", {}, '  rust:\n    versions: [stable, "1.85"]');
    expect(rust.ci.rust?.image).toBe("rust:latest");
    expect(rust.ci.rust?.parallel).toEqual({ matrix: [{ RUST_VERSION: ["stable", "1.85"] }] });
    expect(rust.ci.rust?.script.slice(0, 3)).toEqual([
      'rustup toolchain install "$RUST_VERSION" --profile minimal --component rustfmt,clippy',
      'rustup default "$RUST_VERSION"',
      "cargo fmt --all --check",
    ]);
    expectBump(rust, ["Cargo.toml", "Cargo.lock"]);
  });

  it("ruby and php: the install command, then the checks", async () => {
    const ruby = await onGitlab("ruby");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
    expect(ruby.ci.ruby?.image).toBe("ruby:${RUBY_VERSION}");
    expect(ruby.ci.ruby?.parallel).toEqual({ matrix: [{ RUBY_VERSION: ["3.3", "3.4"] }] });
    expect(ruby.ci.ruby?.script).toEqual(["bundle install", "bundle exec rake test"]);
    expectBump(ruby, ["lib/fixture/version.rb", "Gemfile.lock"]);

    const php = await onGitlab("php");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
    expect(php.ci.php?.image).toBe("php:${PHP_VERSION}-cli");
    expect(php.ci.php?.parallel).toEqual({ matrix: [{ PHP_VERSION: ["8.3", "8.4"] }] });
    // Composer is not in the image
    expect(php.ci.php?.script[0]).toContain("--install-dir=/usr/local/bin --filename=composer");
    expect(php.ci.php?.script.slice(1)).toEqual([
      "composer install --no-interaction --no-progress",
      "composer validate --no-check-publish",
      "composer test",
    ]);
    expectBump(php, ["composer.json"]);
  });

  it("dart and flutter: the SDK's own image", async () => {
    const dart = await onGitlab("dart");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
    expect(dart.ci.dart?.image).toBe("dart:${SDK_VERSION}");
    expect(dart.ci.dart?.parallel).toEqual({ matrix: [{ SDK_VERSION: ["stable"] }] });
    expect(dart.ci.dart?.script).toEqual([
      "dart pub get",
      "dart format --output=none --set-exit-if-changed .",
      "dart analyze",
      "dart test",
    ]);
    expectBump(dart, ["pubspec.yaml"]);

    const pubspec = `${await readFile(join(fixtures, "dart/pubspec.yaml"), "utf8")}\ndependencies:\n  flutter:\n    sdk: flutter\n`;
    const flutter = await onGitlab("dart", { "pubspec.yaml": pubspec });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
    expect(flutter.ci.dart?.image).toBe("ghcr.io/cirruslabs/flutter:${SDK_VERSION}");
    expect(flutter.ci.dart?.script).toEqual([
      "flutter pub get",
      "dart format --output=none --set-exit-if-changed .",
      "flutter analyze",
      "flutter test",
    ]);
  });

  it("java and kotlin: Maven's image, Gradle's, or a JDK for the project's own wrapper", async () => {
    const maven = await onGitlab("java-maven");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
    expect(maven.ci.java?.image).toBe("maven:3-eclipse-temurin-${JAVA_VERSION}");
    expect(maven.ci.java?.parallel).toEqual({ matrix: [{ JAVA_VERSION: ["17", "21"] }] });
    expect(maven.ci.java?.script).toEqual(["mvn -B verify"]);
    expectBump(maven, ["pom.xml"]);

    const gradle = await onGitlab("java-gradle");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
    expect(gradle.ci.java?.image).toBe("gradle:jdk${JAVA_VERSION}");
    expect(gradle.ci.java?.script).toEqual(["gradle check"]);
    // no version in the build: the release is the changelog and the tag
    expect(gradle.plugin("@semantic-release/exec")).toBeUndefined();
    expect(gradle.plugin("@semantic-release/git")?.assets).toEqual(["CHANGELOG.md"]);
    expect(gradle.releaseScript).not.toContain("@semantic-release/exec");

    const wrapped = await onGitlab("java-gradle", { gradlew: "#!/bin/sh\n" });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
    expect(wrapped.ci.java?.image).toBe("eclipse-temurin:${JAVA_VERSION}-jdk");
    expect(wrapped.ci.java?.script).toEqual(["./gradlew check"]);

    const kotlin = await onGitlab("kotlin");
    expect(Object.keys(kotlin.ci)).toEqual(["workflow", "kotlin", "commits", "renovate", "release"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
    expect(kotlin.ci.kotlin?.image).toBe("gradle:jdk${JAVA_VERSION}");
    expectBump(kotlin, ["gradle.properties"]);
    // the markers `repokeeper bump` writes between are put around the version line on GitLab too
    expect(await readFile(join(kotlin.dir, "gradle.properties"), "utf8")).toContain("x-release-please-start-version");
  });

  it("dotnet: one job on the newest SDK's image, the older SDKs installed beside it", async () => {
    const dotnet = await onGitlab("dotnet", {}, '  dotnet:\n    versions: ["8.0", "10.0", "9.0"]');
    expect(dotnet.ci.dotnet).toEqual({
      stage: "test",
      image: "mcr.microsoft.com/dotnet/sdk:10.0",
      rules: FOR_CHANGES,
      variables: { DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
      script: [
        "curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 9.0 --install-dir /usr/share/dotnet",
        "curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir /usr/share/dotnet",
        "dotnet restore",
        "dotnet format --verify-no-changes --no-restore",
        "dotnet build --no-restore",
        "dotnet test --no-build",
      ],
    });
    const versioned = await onGitlab("dotnet", {
      "Directory.Build.props":
        "<Project>\n  <PropertyGroup>\n    <Version>0.1.0</Version>\n  </PropertyGroup>\n</Project>\n",
    });
    expectBump(versioned, ["Directory.Build.props"]);
  });

  it("script: a job per kind of script, with the versions the GitHub workflow pins", async () => {
    const script = await onGitlab("script", {}, "  script:\n    test: ./run-tests.sh");
    expect(Object.keys(script.ci)).toEqual([
      "workflow",
      "shell",
      "powershell",
      "script-test",
      "commits",
      "renovate",
      "release",
    ]);
    expect(script.ci.shell?.image).toBe("koalaman/shellcheck-alpine:stable");
    expect(script.ci.shell?.script.slice(0, 2)).toEqual([
      "apk add --no-cache git > /dev/null",
      "git ls-files -z '*.sh' | xargs -0 -r shellcheck",
    ]);
    expect(script.ci.shell?.script[2]).toContain(`/v${SHFMT_VERSION}/shfmt_v${SHFMT_VERSION}_linux_amd64`);
    expect(script.ci.powershell?.image).toBe("mcr.microsoft.com/dotnet/sdk:10.0");
    // a module that fails to load must fail the job, not leave nothing to report
    expect(script.ci.powershell?.script[0]).toContain('$ErrorActionPreference = "Stop"');
    expect(script.ci.powershell?.script[0]).toContain(`-RequiredVersion ${SCRIPT_ANALYZER_VERSION} `);
    expect(script.ci["script-test"]?.script).toEqual(["./run-tests.sh"]);
    for (const job of [script.ci.shell, script.ci.powershell, script.ci["script-test"]]) {
      expect(job?.rules).toEqual(FOR_CHANGES);
      expect(job?.parallel).toBeUndefined();
    }
    const github = await readFile(join(workflows, "stack-script.yml"), "utf8");
    expect(github).toContain(`shfmt_v${SHFMT_VERSION}_linux_amd64`);
    expect(github).toContain(`-RequiredVersion ${SCRIPT_ANALYZER_VERSION} `);
  });

  // Renovate reads .gitlab-ci.yml too. An image one of repokeeper's jobs names with a version is the standard's
  // to move, so Renovate is told to leave it: otherwise it opens a merge request against a managed key.
  it("names for Renovate every image its own jobs pin to a version", async () => {
    const pinned = new Set<string>();
    for (const fixture of FIXTURES) {
      const project = await onGitlab(fixture);
      for (const job of Object.values(project.ci)) {
        const image = (job as Partial<Job>).image;
        if (!image) continue;
        const at = image.lastIndexOf(":");
        const [name, tag] = at < 0 ? [image, "latest"] : [image.slice(0, at), image.slice(at + 1)];
        // a CI variable or a moving tag is nothing Renovate can raise
        if (tag.includes("${") || tag === "latest" || tag === "stable") continue;
        pinned.add(name);
      }
      const renovate = JSON.parse(await readFile(join(project.dir, "renovate.json"), "utf8")) as {
        packageRules: Array<Record<string, unknown>>;
      };
      expect(renovate.packageRules.at(-1)).toEqual({
        matchManagers: ["gitlabci"],
        matchFileNames: [".gitlab-ci.yml"],
        matchPackageNames: [...MANAGED_IMAGES],
        enabled: false,
      });
    }
    expect([...pinned].sort()).toEqual([...MANAGED_IMAGES].sort());
  });

  it("says that os has no effect, whichever stack names one", async () => {
    const python = await onGitlab("python", {}, "  python:\n    os: [ubuntu-latest, windows-latest]");
    const c = capture(python.dir);
    expect(await run(["check"], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("note: python.os is ignored on gitlab (Linux runners only)");
  });

  it("leaves a Node.js project's release exactly as it was", async () => {
    const node = await onGitlab("node");
    expect(node.plugin("@semantic-release/exec")).toBeUndefined();
    expect(node.plugin("@semantic-release/npm")).toEqual({ npmPublish: false });
    expect(node.releaseScript).not.toContain("@semantic-release/exec");
  });
});
