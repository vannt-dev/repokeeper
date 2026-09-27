import { defaultBranch } from "../config/types.js";
import { UsageError } from "../errors.js";
import { MANAGED_HEADER, type Module, type Output } from "../model.js";
import { readTemplate } from "../templates.js";
import { TOOL_VERSIONS } from "../version.js";

const MIT = (holder: string) => `MIT License

Copyright (c) ${holder}

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

const md = (path: string, content: string): Output => ({ kind: "file", module: "health", path, content });

export const healthModule: Module = {
  id: "health",
  enabled: (config) => config.modules.health !== false,
  outputs(ctx) {
    const health = ctx.config.modules.health;
    if (!health) return [];
    const { owner, name } = ctx.repo;
    const outputs: Output[] = [];

    if (health.license !== false) {
      if (health.license !== "MIT") {
        throw new UsageError(
          `license ${health.license} is not bundled with this version of repokeeper; use MIT, or set modules.health.license to false`,
        );
      }
      outputs.push(md("LICENSE", MIT(health.copyright)));
    }

    const report = owner
      ? `through [GitHub security advisories](https://github.com/${owner}/${name}/security/advisories/new)`
      : "through the repository's Security tab (Report a vulnerability)";
    outputs.push(
      md(
        "SECURITY.md",
        `# Security Policy\n\n<!-- ${MANAGED_HEADER} -->\n\n## Supported versions\n\nSecurity fixes are released for the latest published version.\n\n## Reporting a vulnerability\n\nPlease do not open a public issue. Report the vulnerability privately ${report}.\nThe maintainers will acknowledge it as soon as possible and keep you informed until it is resolved.\n`,
      ),
    );

    const install = ctx.stacks.map((s) => s.install).filter((c): c is string => c !== null);
    const run = install.length ? `Run ${install.map((c) => `\`${c}\``).join(" and ")}.` : "";
    const hooks = ctx.stacks.some((s) => s.id === "node")
      ? "Installing the dependencies also installs the git hooks (lefthook)."
      : `${run ? "Then run" : "Run"} \`npx --yes lefthook@${TOOL_VERSIONS.lefthook} install\` once to enable the git hooks (they need Node.js 22 or newer).`;
    const setup = [run, hooks].filter(Boolean).join(" ");
    outputs.push(
      md(
        "CONTRIBUTING.md",
        `# Contributing\n\n<!-- ${MANAGED_HEADER} -->\n\nThanks for helping improve this project.\n\n## Local setup\n\n${setup}\n\n## Workflow\n\n1. Create a branch from \`${defaultBranch(ctx.config)}\`.\n2. Write commit messages in [Conventional Commits](https://www.conventionalcommits.org/) form, for example \`feat: add export button\` or \`fix(api): handle empty input\`. The \`commit-msg\` hook checks them.\n3. Open a pull request. It is merged once the checks pass and it has been reviewed.\n\nPlease follow the [Code of Conduct](CODE_OF_CONDUCT.md).\n`,
      ),
    );

    outputs.push(
      md("CODE_OF_CONDUCT.md", readTemplate("CODE_OF_CONDUCT.md").replace("[INSERT CONTACT METHOD]", health.contact)),
    );
    outputs.push(...ctx.platform.communityFiles(ctx));
    return outputs;
  },
};
