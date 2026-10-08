import { stringify } from "yaml";
import { MANAGED_HEADER, type Module, nodeAtRoot, type Output, type ResolvedStack } from "../model.js";
import { TOOL_VERSIONS } from "../version.js";

/** lefthook runs a job from `root` and hands it only the staged files under it. */
const rootOf = (stack: ResolvedStack) => (stack.directory ? { root: `${stack.directory}/` } : {});

export const hooksModule: Module = {
  id: "hooks",
  enabled: (config) => config.modules.hooks,
  outputs(ctx) {
    const config: Record<string, unknown> = {};
    const preCommit = ctx.stacks.flatMap((s) => s.staged.map((job) => ({ ...job, ...rootOf(s), stage_fixed: true })));
    if (preCommit.length > 0) config["pre-commit"] = { parallel: true, jobs: preCommit };
    if (ctx.config.modules.commits) {
      const node = nodeAtRoot(ctx.stacks);
      const commitlint = node
        ? "npx --no-install commitlint --edit {1}"
        : `npx --yes --package @commitlint/cli@${TOOL_VERSIONS.commitlintCli} --package @commitlint/config-conventional@${TOOL_VERSIONS.commitlintConventional} -- commitlint --edit {1}`;
      config["commit-msg"] = { jobs: [{ name: "commitlint", run: commitlint }] };
    }
    const prePush = ctx.stacks.flatMap((s) => (s.test ? [{ name: `${s.id}:test`, run: s.test, ...rootOf(s) }] : []));
    if (prePush.length > 0) config["pre-push"] = { jobs: prePush };

    const outputs: Output[] = [
      {
        kind: "file",
        module: "hooks",
        path: "lefthook.yml",
        content: `# ${MANAGED_HEADER}\n${stringify(config, { lineWidth: 0 })}`,
      },
    ];
    if (nodeAtRoot(ctx.stacks)) {
      outputs.push({
        kind: "json",
        module: "hooks",
        path: "package.json",
        keyPath: ["devDependencies", "lefthook"],
        value: `^${TOOL_VERSIONS.lefthook}`,
      });
    }
    return outputs;
  },
};
