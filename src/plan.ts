import { type Module, type ModuleContext, type Output, outputId } from "./model.js";
import { MODULES } from "./modules/index.js";
import { isOwned } from "./owned.js";
import { targetOf } from "./sync/lock.js";

/** Pure: the outputs the standard asks for, given the config and resolved stacks. */
export function planOutputs(ctx: ModuleContext, modules: Module[] = MODULES): Output[] {
  const outputs = modules
    .filter((module) => module.enabled(ctx.config))
    .flatMap((module) => module.outputs(ctx))
    .filter((output) => !isOwned(ctx.config.owned, targetOf(output)));
  const seen = new Set<string>();
  for (const output of outputs) {
    const id = outputId(output);
    if (seen.has(id)) throw new Error(`two modules produce ${id}`);
    seen.add(id);
  }
  return outputs.sort((a, b) => outputId(a).localeCompare(outputId(b)));
}
