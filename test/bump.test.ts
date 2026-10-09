import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  bumpCargoLock,
  bumpCargoToml,
  bumpComposer,
  bumpGemfileLock,
  bumpMarked,
  bumpPom,
  bumpPubspec,
  bumpPyproject,
  bumpRubyVersion,
  bumpSetupCfg,
  bumpSetupPy,
  bumpXml,
  releaseFiles,
} from "../src/release/bump.js";
import { capture, tempDir } from "./helpers.js";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** The lines of `after` that differ from `before`, which have to be the version and nothing else. */
function changedLines(before: string, after: string): string[] {
  const old = before.split("\n");
  const lines = after.split("\n");
  expect(lines).toHaveLength(old.length);
  return lines.filter((line, index) => line !== old[index]);
}

describe("version files", () => {
  it("pyproject.toml: the project's version, not a tool's or a dependency's", () => {
    const text = [
      "[build-system]",
      'requires = ["setuptools>=69"]',
      "",
      "[tool.demo]",
      'version = "9.9.9"',
      "",
      "[project]",
      'name = "demo"',
      'version = "0.1.0"  # the release',
      'dependencies = ["requests>=2.0.0"]',
      "",
      "[tool.ruff]",
      'target-version = "py311"',
      "",
    ].join("\n");
    expect(changedLines(text, bumpPyproject(text, "1.2.3") as string)).toEqual(['version = "1.2.3"  # the release']);
    const poetry = '[tool.poetry]\nname = "demo"\nversion = "0.1.0"\n';
    expect(bumpPyproject(poetry, "1.2.3")).toBe('[tool.poetry]\nname = "demo"\nversion = "1.2.3"\n');
    // a version read from the source tree is not in the file to change
    expect(bumpPyproject('[project]\nname = "demo"\ndynamic = ["version"]\n', "1.2.3")).toBeNull();
    expect(bumpPyproject("[tool.ruff]\nline-length = 100\n", "1.2.3")).toBeNull();
  });

  it("setup.cfg and setup.py", () => {
    const cfg = "[metadata]\nname = demo\nversion = 0.1.0\n\n[options]\nversion = keep\n";
    expect(bumpSetupCfg(cfg, "1.2.3")).toBe("[metadata]\nname = demo\nversion = 1.2.3\n\n[options]\nversion = keep\n");
    expect(bumpSetupCfg("[metadata]\nversion = attr: demo.__version__\n", "1.2.3")).toBeNull();
    expect(bumpSetupPy("setup(\n    name='demo',\n    version='0.1.0',\n)\n", "1.2.3")).toBe(
      "setup(\n    name='demo',\n    version='1.2.3',\n)\n",
    );
    expect(bumpSetupPy("setup(name='demo')\n", "1.2.3")).toBeNull();
  });

  it("pubspec.yaml: keeps a build number and counts it up", () => {
    const text =
      "name: demo\nversion: 0.1.0\nenvironment:\n  sdk: ^3.5.0\ndependencies:\n  path:\n    version: 1.0.0\n";
    expect(changedLines(text, bumpPubspec(text, "1.2.3") as string)).toEqual(["version: 1.2.3"]);
    expect(bumpPubspec("name: demo\nversion: 1.0.0+41\n", "1.2.3")).toBe("name: demo\nversion: 1.2.3+42\n");
    expect(bumpPubspec("name: demo\n", "1.2.3")).toBeNull();
  });

  it("pom.xml: the project's own version, past the parent, comments, dependencies and plugins", () => {
    const text = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<project xmlns="http://maven.apache.org/POM/4.0.0">',
      "  <modelVersion>4.0.0</modelVersion>",
      "  <!-- <version>7.7.7</version> -->",
      "  <parent>",
      "    <groupId>org.demo</groupId>",
      "    <artifactId>parent</artifactId>",
      "    <version>3.3.3</version>",
      "  </parent>",
      "  <artifactId>demo</artifactId>",
      "  <dependencies>",
      "    <dependency>",
      "      <artifactId>lib</artifactId>",
      "      <version>5.5.5</version>",
      "    </dependency>",
      "  </dependencies>",
      "  <version>0.1.0</version>",
      "  <build><plugins><plugin><version>2.2.2</version></plugin></plugins></build>",
      "</project>",
      "",
    ].join("\n");
    expect(changedLines(text, bumpPom(text, "1.2.3") as string)).toEqual(["  <version>1.2.3</version>"]);
    // a module that takes its version from the parent has none of its own to change
    const inherited =
      "<project><parent><artifactId>p</artifactId><version>3.3.3</version></parent><artifactId>m</artifactId></project>";
    expect(bumpPom(inherited, "1.2.3")).toBeNull();
  });

  it("Cargo.toml and the crate's own entry in Cargo.lock", () => {
    const toml =
      '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = { version = "1.0.0" }\n';
    expect(changedLines(toml, bumpCargoToml(toml, "1.2.3") as string)).toEqual(['version = "1.2.3"']);
    const workspace = '[package]\nname = "demo"\nversion.workspace = true\n\n[workspace.package]\nversion = "0.1.0"\n';
    expect(bumpCargoToml(workspace, "1.2.3")).toContain('[workspace.package]\nversion = "1.2.3"');
    const lock = [
      "version = 4",
      "",
      "[[package]]",
      'name = "demo-macros"',
      'version = "0.1.0"',
      "",
      "[[package]]",
      'name = "demo"',
      'version = "0.1.0"',
      "dependencies = [",
      ' "serde",',
      "]",
      "",
      "[[package]]",
      'name = "serde"',
      'version = "1.0.0"',
      "",
    ].join("\n");
    const bumped = bumpCargoLock(lock, "demo", "1.2.3") as string;
    expect(changedLines(lock, bumped)).toEqual(['version = "1.2.3"']);
    expect(bumped).toContain('name = "demo"\nversion = "1.2.3"');
    expect(bumped).toContain('name = "demo-macros"\nversion = "0.1.0"');
    expect(bumpCargoLock(lock, "absent", "1.2.3")).toBeNull();
  });

  it("composer.json: only a version the project already keeps", () => {
    const text = '{\n  "name": "acme/demo",\n  "version": "0.1.0",\n  "require": { "php": ">=8.3" }\n}\n';
    expect(changedLines(text, bumpComposer(text, "1.2.3") as string)).toEqual(['  "version": "1.2.3",']);
    expect(bumpComposer('{\n  "name": "acme/demo"\n}\n', "1.2.3")).toBeNull();
    expect(bumpComposer("not json", "1.2.3")).toBeNull();
  });

  it("version.rb and the gem's own entry in Gemfile.lock", () => {
    expect(bumpRubyVersion('module Demo\n  VERSION = "0.1.0"\nend\n', "1.2.3")).toBe(
      'module Demo\n  VERSION = "1.2.3"\nend\n',
    );
    const lock =
      "PATH\n  remote: .\n  specs:\n    demo (0.1.0)\n      rake (>= 13.0)\n\nGEM\n  remote: https://rubygems.org/\n  specs:\n    rake (13.2.1)\n";
    expect(changedLines(lock, bumpGemfileLock(lock, "1.2.3") as string)).toEqual(["    demo (1.2.3)"]);
    expect(bumpGemfileLock("GEM\n  remote: https://rubygems.org/\n  specs:\n    rake (13.2.1)\n", "1.2.3")).toBeNull();
  });

  it("an XML element by its path, and lines between release-please markers", () => {
    const props =
      '<Project>\n  <ItemGroup>\n    <PackageReference Include="X" Version="4.4.4" />\n  </ItemGroup>\n  <PropertyGroup>\n    <Version>0.1.0</Version>\n  </PropertyGroup>\n</Project>\n';
    expect(changedLines(props, bumpXml(props, "//Project/PropertyGroup/Version", "1.2.3") as string)).toEqual([
      "    <Version>1.2.3</Version>",
    ]);
    expect(bumpXml(props, "//Project/PropertyGroup/Missing", "1.2.3")).toBeNull();
    const marked =
      "group=dev.demo\n# x-release-please-start-version\nversion=0.1.0\n# x-release-please-end\nkotlin.version=2.0.0\n";
    expect(changedLines(marked, bumpMarked(marked, "1.2.3") as string)).toEqual(["version=1.2.3"]);
    expect(bumpMarked('spec.version = "0.1.0" # x-release-please-version\n', "1.2.3")).toBe(
      'spec.version = "1.2.3" # x-release-please-version\n',
    );
    // without markers the generic updater changes nothing, as on GitHub
    expect(bumpMarked("version=0.1.0\n", "1.2.3")).toBeNull();
  });

  it("names the files a release can change, for the release tool to commit", () => {
    expect(releaseFiles({ type: "python", version: "0.1.0" })).toEqual(["pyproject.toml", "setup.cfg", "setup.py"]);
    expect(releaseFiles({ type: "rust", version: "0.1.0" })).toEqual(["Cargo.toml", "Cargo.lock"]);
    expect(releaseFiles({ type: "ruby", version: "0.1.0", versionFile: "lib/demo/version.rb" })).toEqual([
      "lib/demo/version.rb",
      "Gemfile.lock",
    ]);
    expect(
      releaseFiles({
        type: "simple",
        version: "0.1.0",
        extraFiles: [
          "gradle.properties",
          { type: "xml", path: "Directory.Build.props", xpath: "//Project/PropertyGroup/Version" },
        ],
      }),
    ).toEqual(["gradle.properties", "Directory.Build.props"]);
    expect(releaseFiles({ type: "go", version: null })).toEqual([]);
    expect(releaseFiles({ type: "node", version: "0.1.0" })).toEqual([]);
  });
});

describe("repokeeper bump", () => {
  const config = (stack: string) =>
    `schema: 1\nstandard: 1.4.3\nplatform: github\nstacks: [${stack}]\nmodules:\n  health: false\n`;

  async function project(fixture: string, stack: string): Promise<string> {
    const dir = await tempDir();
    await cp(join(fixtures, fixture), dir, { recursive: true });
    await writeFile(join(dir, ".repokeeper.yml"), config(stack));
    return dir;
  }

  async function bump(dir: string, ...args: string[]) {
    const c = capture(dir);
    const code = await run(["bump", ...args], c.io);
    return { code, out: c.out.join("\n"), err: c.err.join("\n") };
  }

  const cases: Array<[fixture: string, stack: string, file: string, line: string]> = [
    ["python", "python", "pyproject.toml", 'version = "1.2.3"'],
    ["rust", "rust", "Cargo.toml", 'version = "1.2.3"'],
    ["dart", "dart", "pubspec.yaml", "version: 1.2.3"],
    ["java-maven", "java", "pom.xml", "  <version>1.2.3</version>"],
    ["ruby", "ruby", "lib/fixture/version.rb", '  VERSION = "1.2.3"'],
  ];
  for (const [fixture, stack, file, line] of cases) {
    it(`changes one line of ${file} in the ${fixture} fixture`, async () => {
      const dir = await project(fixture, stack);
      const before = await readFile(join(dir, file), "utf8");

      const dry = await bump(dir, "1.2.3", "--dry-run");
      expect(dry.out).toBe(`bumped     ${file}\ndry run: nothing written`);
      expect(await readFile(join(dir, file), "utf8")).toBe(before);

      const result = await bump(dir, "1.2.3");
      expect(result.code).toBe(0);
      expect(result.out).toBe(`bumped     ${file}`);
      expect(changedLines(before, await readFile(join(dir, file), "utf8"))).toEqual([line]);
      // the same version again has nothing left to change
      expect((await bump(dir, "1.2.3")).out).toContain("holds a version to change");
    });
  }

  it("changes gradle.properties between the markers the release module writes", async () => {
    const dir = await project("kotlin", "kotlin");
    // without the markers the line is the user's own, on GitHub and here alike
    expect((await bump(dir, "1.2.3")).out).toContain("no file of the kotlin stack holds a version to change");
    await writeFile(
      join(dir, "gradle.properties"),
      "# x-release-please-start-version\nversion=0.0.0\n# x-release-please-end\n",
    );
    expect((await bump(dir, "1.2.3")).out).toBe("bumped     gradle.properties");
    expect(await readFile(join(dir, "gradle.properties"), "utf8")).toBe(
      "# x-release-please-start-version\nversion=1.2.3\n# x-release-please-end\n",
    );
  });

  it("says so when the release is only a tag, and refuses what is not a version", async () => {
    const go = await bump(await project("go", "go"), "1.2.3");
    expect(go.code).toBe(0);
    expect(go.out).toBe("no file of the go stack holds a version to change; the release is its tag");
    const php = await bump(await project("php", "php"), "1.2.3");
    expect(php.out).toContain("no file of the php stack holds a version to change");
    for (const args of [[], ["next"], ["v1.2.3"], ["1.2"]]) {
      const refused = await bump(await project("go", "go"), ...args);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain("usage: repokeeper bump <version>");
    }
  });
});
