import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/commands/context.js";
import { parseConfig } from "../src/config/load.js";
import type { Output } from "../src/model.js";
import { healthModule } from "../src/modules/health.js";
import { githubPlatform } from "../src/platforms/github.js";
import { platformFor } from "../src/platforms/index.js";
import { gitlabContext, makeContext, tempDir } from "./helpers.js";

const files = (outputs: Output[]) =>
  Object.fromEntries(outputs.flatMap((o) => (o.kind === "file" ? [[o.path, o.content]] : [])));

describe("gitlab community files", () => {
  it("writes issue and merge request templates and CODEOWNERS under .gitlab", () => {
    const out = files(healthModule.outputs(gitlabContext()));
    expect(out[".gitlab/issue_templates/Bug.md"]).toContain("## What happened?");
    expect(out[".gitlab/issue_templates/Bug.md"]).toMatch(/\n\/label ~bug\n$/);
    expect(out[".gitlab/issue_templates/Feature.md"]).toContain("## What problem would this solve?");
    expect(out[".gitlab/issue_templates/Feature.md"]).toMatch(/\n\/label ~enhancement\n$/);
    expect(out[".gitlab/merge_request_templates/Default.md"]).toContain("- [ ] Tests added or updated");
    expect(out[".gitlab/CODEOWNERS"]).toMatch(/\n\* @vannt-dev\n$/);
    expect(Object.keys(out).some((path) => path.startsWith(".github/"))).toBe(false);
  });

  it("leaves CODEOWNERS out without owners", () => {
    const health = { license: "MIT", copyright: "2026 Demo", contact: "x", codeowners: [] };
    const out = files(healthModule.outputs(gitlabContext({ modules: { health } })));
    expect(out[".gitlab/CODEOWNERS"]).toBeUndefined();
  });
});

describe("platform wording", () => {
  it("asks for a confidential issue and a merge request on gitlab", () => {
    const out = files(healthModule.outputs(gitlabContext()));
    expect(out["SECURITY.md"]).toContain(
      "by opening a [confidential issue](https://gitlab.com/acme/tools/example/-/issues/new?issue%5Bconfidential%5D=true)",
    );
    expect(out["SECURITY.md"]).not.toContain("advisories");
    expect(out["CONTRIBUTING.md"]).toContain("3. Open a merge request.");
  });

  it("uses the remote's host on a self-hosted GitLab", () => {
    const repo = { host: "git.example.org", owner: "acme", name: "example" };
    expect(files(healthModule.outputs(gitlabContext({ repo })))["SECURITY.md"]).toContain(
      "https://git.example.org/acme/example/-/issues/new",
    );
    expect(platformFor("gitlab").profileUrl(repo)).toBe("https://git.example.org/acme");
  });

  it("falls back to plain wording without a remote", () => {
    const repo = { owner: null, name: "example" };
    expect(files(healthModule.outputs(gitlabContext({ repo })))["SECURITY.md"]).toContain(
      "by opening a confidential issue in the repository",
    );
    expect(platformFor("gitlab").profileUrl(repo)).toBeNull();
  });

  it("keeps the GitHub wording", () => {
    const out = files(healthModule.outputs(makeContext()));
    expect(out["CONTRIBUTING.md"]).toContain("3. Open a pull request.");
    expect(githubPlatform.profileUrl({ owner: "vannt-dev", name: "example" })).toBe("https://github.com/vannt-dev");
    expect(githubPlatform.profileUrl({ owner: null, name: "example" })).toBeNull();
  });
});

describe("platform selection", () => {
  const config = (platform: string, stack: string) =>
    parseConfig(`schema: 1\nstandard: 1.0.0\nplatform: ${platform}\nstacks: [${stack}]\nmodules:\n  health: false\n`);

  it("builds the context with the configured platform's adapter", async () => {
    const root = await tempDir();
    await writeFile(join(root, "package.json"), "{}\n");
    expect((await buildContext(root, config("gitlab", "node"))).platform.id).toBe("gitlab");
    expect((await buildContext(root, config("github", "node"))).platform.id).toBe("github");
  });

  it("refuses a stack gitlab does not support yet", async () => {
    await expect(buildContext(await tempDir(), config("gitlab", "python"))).rejects.toThrow(
      'stack "python" is not supported on gitlab yet (supported: node)',
    );
  });
});
