import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LICENSES } from "../src/licenses.js";
import type { FileOutput } from "../src/model.js";
import { depsModule } from "../src/modules/deps.js";
import { healthModule } from "../src/modules/health.js";
import { makeContext } from "./helpers.js";

/** The LICENSE repokeeper wrote for MIT before other licenses were bundled; it must not move. */
const MIT_2026_VAN_NGUYEN = `MIT License

Copyright (c) 2026 Van Nguyen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const files = (outputs: ReturnType<typeof healthModule.outputs>) =>
  Object.fromEntries(outputs.map((o) => [o.path, (o as FileOutput).content]));

describe("health", () => {
  it("writes the community health files", () => {
    const out = files(healthModule.outputs(makeContext()));
    expect(Object.keys(out).sort()).toEqual([
      ".github/CODEOWNERS",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/pull_request_template.md",
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "LICENSE",
      "SECURITY.md",
    ]);
    expect(out.LICENSE).toContain("Copyright (c) 2026 Van Nguyen");
    expect(out["CODE_OF_CONDUCT.md"]).toContain("https://github.com/vannt-dev");
    expect(out["CODE_OF_CONDUCT.md"]).not.toContain("[INSERT CONTACT METHOD]");
    expect(out["SECURITY.md"]).toContain("https://github.com/vannt-dev/example/security/advisories/new");
    expect(out["CONTRIBUTING.md"]).toContain("`npm install`");
    expect(out[".github/CODEOWNERS"]).toContain("* @vannt-dev");
    for (const path of Object.keys(out).filter((p) => p.endsWith(".yml")))
      expect(() => parse(out[path] as string)).not.toThrow();
  });

  it("omits CODEOWNERS and the advisory link when the owner is unknown", () => {
    const ctx = makeContext({
      repo: { owner: null, name: "x" },
      modules: { health: { license: "MIT", copyright: "2026 A", contact: "a@example.com", codeowners: [] } },
    });
    const out = files(healthModule.outputs(ctx));
    expect(out[".github/CODEOWNERS"]).toBeUndefined();
    expect(out["SECURITY.md"]).toContain("Security tab");
    expect(parse(out[".github/ISSUE_TEMPLATE/config.yml"] as string).contact_links).toEqual([]);
  });

  it("leaves licensing alone when license is false and rejects unbundled licenses", () => {
    const off = makeContext({ modules: { health: { license: false, copyright: "x", contact: "x", codeowners: [] } } });
    expect(files(healthModule.outputs(off)).LICENSE).toBeUndefined();
    const other = makeContext({
      modules: { health: { license: "WTFPL", copyright: "x", contact: "x", codeowners: [] } },
    });
    expect(() => healthModule.outputs(other)).toThrow(/WTFPL.*Apache-2\.0/);
  });

  const licenseFor = (license: string, copyright = "2026 Van Nguyen") =>
    files(
      healthModule.outputs(makeContext({ modules: { health: { license, copyright, contact: "x", codeowners: [] } } })),
    ).LICENSE as string;

  it("writes the MIT license exactly as before", () => {
    expect(licenseFor("MIT")).toBe(MIT_2026_VAN_NGUYEN);
  });

  it("bundles the full text of every license it names, with the holder filled in", () => {
    expect(LICENSES).toEqual([
      "MIT",
      "Apache-2.0",
      "BSD-3-Clause",
      "GPL-3.0-only",
      "GPL-3.0-or-later",
      "ISC",
      "MPL-2.0",
      "Unlicense",
    ]);
    const firstLines: Record<string, string> = {
      "Apache-2.0": "                                 Apache License",
      "BSD-3-Clause": "BSD 3-Clause License",
      "GPL-3.0-only": "                    GNU GENERAL PUBLIC LICENSE",
      "GPL-3.0-or-later": "                    GNU GENERAL PUBLIC LICENSE",
      ISC: "ISC License",
      "MPL-2.0": "Mozilla Public License Version 2.0",
      Unlicense: "This is free and unencumbered software released into the public domain.",
    };
    for (const [id, first] of Object.entries(firstLines)) {
      const text = licenseFor(id);
      expect(text.split("\n")[0], id).toBe(first);
      expect(text.endsWith("\n"), id).toBe(true);
      expect(text, id).not.toMatch(/\r|\[year\]|\[fullname\]/);
    }
    expect(licenseFor("Apache-2.0")).toContain("Version 2.0, January 2004");
    expect(licenseFor("Apache-2.0")).toContain("END OF TERMS AND CONDITIONS");
    expect(licenseFor("GPL-3.0-only")).toContain("Version 3, 29 June 2007");
    expect(licenseFor("GPL-3.0-or-later")).toBe(licenseFor("GPL-3.0-only"));
    expect(licenseFor("MPL-2.0")).toContain('Exhibit B - "Incompatible With Secondary Licenses" Notice');
    expect(licenseFor("BSD-3-Clause")).toContain("\nCopyright (c) 2026 Van Nguyen\n");
    expect(licenseFor("ISC")).toContain("\nCopyright (c) 2026 Van Nguyen\n");
    // these carry no holder line; the text stays as published
    for (const id of ["Apache-2.0", "GPL-3.0-only", "MPL-2.0", "Unlicense"]) {
      expect(licenseFor(id, "2031 Someone Else"), id).toBe(licenseFor(id));
    }
  });

  it("is disabled when modules.health is false", () => {
    expect(healthModule.enabled(makeContext({ modules: { health: false } }).config)).toBe(false);
  });
});

describe("deps", () => {
  it("configures weekly grouped updates for each ecosystem plus GitHub Actions", () => {
    const [output] = depsModule.outputs(makeContext());
    expect(output?.path).toBe(".github/dependabot.yml");
    const config = parse((output as FileOutput).content);
    expect(config.version).toBe(2);
    expect(config.updates.map((u: { "package-ecosystem": string }) => u["package-ecosystem"])).toEqual([
      "npm",
      "github-actions",
    ]);
    expect(config.updates[0].schedule).toEqual({ interval: "weekly" });
    expect(config.updates[0].groups["npm-minor-and-patch"]["update-types"]).toEqual(["minor", "patch"]);
    // @types/node majors follow the Node.js line the project runs on, not the latest release
    expect(config.updates[0].ignore).toEqual([
      { "dependency-name": "@types/node", "update-types": ["version-update:semver-major"] },
    ]);
    expect(config.updates[1].ignore).toBeUndefined();
  });

  it("gives Dependabot commits a Conventional Commits prefix so commitlint accepts them", () => {
    const [output] = depsModule.outputs(makeContext());
    const config = parse((output as FileOutput).content);
    // Dependabot only infers the prefix from history, so a young repository gets "Bump x from 1 to 2"
    for (const update of config.updates)
      expect(update["commit-message"]).toEqual({ prefix: "chore", include: "scope" });
  });
});
