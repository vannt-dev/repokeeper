import { defaultBranch } from "../config/types.js";
import { UsageError } from "../errors.js";
import { isLicense, LICENSES, licenseText } from "../licenses.js";
import { inDirectory, MANAGED_HEADER, type Module, nodeAtRoot, type Output } from "../model.js";
import { readTemplate } from "../templates.js";
import { TOOL_VERSIONS } from "../version.js";

const md = (path: string, content: string): Output => ({ kind: "file", module: "health", path, content });

export const healthModule: Module = {
  id: "health",
  enabled: (config) => config.modules.health !== false,
  outputs(ctx) {
    const health = ctx.config.modules.health;
    if (!health) return [];
    const outputs: Output[] = [];

    if (health.license !== false) {
      if (!isLicense(health.license)) {
        throw new UsageError(
          `license ${health.license} is not bundled with this version of repokeeper; use one of ${LICENSES.join(", ")}, or set modules.health.license to false`,
        );
      }
      outputs.push(md("LICENSE", licenseText(health.license, health.copyright)));
    }

    const report = ctx.platform.securityReport(ctx.repo);
    outputs.push(
      md(
        "SECURITY.md",
        `# Security Policy\n\n<!-- ${MANAGED_HEADER} -->\n\n## Supported versions\n\nSecurity fixes are released for the latest published version.\n\n## Reporting a vulnerability\n\nPlease do not open a public issue. Report the vulnerability privately ${report}.\nThe maintainers will acknowledge it as soon as possible and keep you informed until it is resolved.\n`,
      ),
    );

    const install = ctx.stacks.flatMap((s) => (s.install === null ? [] : [inDirectory(s, s.install)]));
    const run = install.length ? `Run ${install.map((c) => `\`${c}\``).join(" and ")}.` : "";
    const hooks = nodeAtRoot(ctx.stacks)
      ? "Installing the dependencies also installs the git hooks (lefthook)."
      : `${run ? "Then run" : "Run"} \`npx --yes lefthook@${TOOL_VERSIONS.lefthook} install\` once to enable the git hooks (they need Node.js 22 or newer).`;
    const setup = [run, hooks].filter(Boolean).join(" ");
    outputs.push(
      md(
        "CONTRIBUTING.md",
        `# Contributing\n\n<!-- ${MANAGED_HEADER} -->\n\nThanks for helping improve this project.\n\n## Local setup\n\n${setup}\n\n## Workflow\n\n1. Create a branch from \`${defaultBranch(ctx.config)}\`.\n2. Write commit messages in [Conventional Commits](https://www.conventionalcommits.org/) form, for example \`feat: add export button\` or \`fix(api): handle empty input\`. The \`commit-msg\` hook checks them.\n3. Open a ${ctx.platform.changeRequest}. It is merged once the checks pass and it has been reviewed.\n\nPlease follow the [Code of Conduct](CODE_OF_CONDUCT.md).\n`,
      ),
    );

    outputs.push(
      md("CODE_OF_CONDUCT.md", readTemplate("CODE_OF_CONDUCT.md").replace("[INSERT CONTACT METHOD]", health.contact)),
    );
    outputs.push(...ctx.platform.communityFiles(ctx));
    return outputs;
  },
};
