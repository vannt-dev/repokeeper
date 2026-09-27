import type { Io } from "../cli.js";
import { loadConfig } from "../config/load.js";
import { UsageError } from "../errors.js";
import { outputId } from "../model.js";
import { planOutputs } from "../plan.js";
import { readLock } from "../sync/lock.js";
import { computeSync } from "../sync/sync.js";
import { compareVersions, STANDARD_VERSION } from "../version.js";
import { buildContext } from "./context.js";
import { type CommandOptions, hasDrift, printResult, printWarnings } from "./report.js";

export function assertSupportedStandard(standard: string): void {
  if (compareVersions(standard, STANDARD_VERSION) > 0) {
    throw new UsageError(
      `this repository uses standard ${standard}, newer than ${STANDARD_VERSION}; upgrade repokeeper`,
    );
  }
}

export async function checkCommand(root: string, options: CommandOptions, io: Io): Promise<number> {
  const config = await loadConfig(root);
  assertSupportedStandard(config.standard);
  const lock = await readLock(root);
  if (!lock) {
    io.err("repokeeper: .repokeeper/lock.json is missing; run `repokeeper init --relock`");
    return 1;
  }
  const ctx = await buildContext(root, config);
  const result = await computeSync(root, planOutputs(ctx), lock, {
    adopt: new Set(),
    accept: new Set(),
    owned: config.owned,
  });
  const behind = config.standard !== STANDARD_VERSION || lock.standard !== STANDARD_VERSION;
  const clean = !hasDrift(result) && !behind;
  if (options.json) {
    io.out(
      JSON.stringify({
        clean,
        standard: { config: config.standard, lock: lock.standard, current: STANDARD_VERSION },
        items: [
          ...result.decisions
            .filter((d) => d.action !== "unchanged")
            .map((d) => ({ id: outputId(d.output), path: d.output.path, action: d.action })),
          ...result.removals.map((r) => ({ id: r.entry.id, path: r.entry.target.path, action: r.action })),
        ],
      }),
    );
    return clean ? 0 : 1;
  }
  printResult(io, result);
  await printWarnings(root, ctx, io);
  if (behind)
    io.out(`standard   ${config.standard} applied, ${STANDARD_VERSION} available (run \`repokeeper update\`)`);
  io.out(clean ? "repository matches the standard" : "repository has drifted from the standard");
  return clean ? 0 : 1;
}
