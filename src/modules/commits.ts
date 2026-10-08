import { MANAGED_HEADER, type Module, nodeAtRoot, type Output } from "../model.js";
import { TOOL_VERSIONS } from "../version.js";

const COMMITLINT_CONFIG = `// ${MANAGED_HEADER}
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 100],
  },
};
`;

export const commitsModule: Module = {
  id: "commits",
  enabled: (config) => config.modules.commits,
  outputs(ctx) {
    const outputs: Output[] = [
      { kind: "file", module: "commits", path: "commitlint.config.mjs", content: COMMITLINT_CONFIG },
    ];
    // a package.json in a folder of its own is the project's, not the place for the repository's tools
    if (nodeAtRoot(ctx.stacks)) {
      outputs.push(
        {
          kind: "json",
          module: "commits",
          path: "package.json",
          keyPath: ["devDependencies", "@commitlint/cli"],
          value: `^${TOOL_VERSIONS.commitlintCli}`,
        },
        {
          kind: "json",
          module: "commits",
          path: "package.json",
          keyPath: ["devDependencies", "@commitlint/config-conventional"],
          value: `^${TOOL_VERSIONS.commitlintConventional}`,
        },
      );
    }
    return outputs;
  },
};
