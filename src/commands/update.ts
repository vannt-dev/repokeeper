import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Io } from "../cli.js";
import { CONFIG_FILE, loadConfig, setStandard } from "../config/load.js";
import { UsageError } from "../errors.js";
import { planOutputs } from "../plan.js";
import { applySync } from "../sync/apply.js";
import { readLock } from "../sync/lock.js";
import { computeSync } from "../sync/sync.js";
import { STANDARD_VERSION } from "../version.js";
import { assertSupportedStandard } from "./check.js";
import { buildContext } from "./context.js";
import { guardUncommitted } from "./init.js";
import { type CommandOptions, nextSteps, printResult, printWarnings } from "./report.js";

export async function updateCommand(root: string, options: CommandOptions, io: Io): Promise<number> {
  const config = await loadConfig(root);
  assertSupportedStandard(config.standard);
  const lock = await readLock(root);
  if (!lock) throw new UsageError(".repokeeper/lock.json is missing; run `repokeeper init --relock` first");
  const ctx = await buildContext(root, { ...config, standard: STANDARD_VERSION });
  const adopt = options.adoptAll ? ("all" as const) : new Set(options.adopt);
  const result = await computeSync(root, planOutputs(ctx), lock, {
    adopt,
    accept: new Set(options.accept),
    owned: config.owned,
  });
  if (!options.dryRun) await guardUncommitted(root, result, options.force, lock);
  printResult(io, result);
  if (options.dryRun) {
    io.out("dry run: nothing written");
    return 0;
  }
  await applySync(root, result, lock, STANDARD_VERSION);
  const steps = await nextSteps(root, ctx, result);
  await printWarnings(root, config, io);
  if (config.standard !== STANDARD_VERSION) {
    const path = join(root, CONFIG_FILE);
    await writeFile(path, setStandard(await readFile(path, "utf8"), STANDARD_VERSION));
  }
  const conflicts = result.decisions.filter((d) => d.action === "conflict");
  if (conflicts.length > 0) {
    io.out(
      `${conflicts.length} file(s) kept because they were edited locally; new versions are beside them as *.repokeeper-new`,
    );
    return 1;
  }
  for (const step of steps) io.out(`next: ${step}`);
  io.out(
    `repository is on standard ${STANDARD_VERSION}; commit with "chore(repokeeper): update standard to ${STANDARD_VERSION}"`,
  );
  return 0;
}
