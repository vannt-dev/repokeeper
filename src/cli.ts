#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkCommand } from "./commands/check.js";
import { githubApplyCommand } from "./commands/github.js";
import { initCommand } from "./commands/init.js";
import type { CommandOptions } from "./commands/report.js";
import { updateCommand } from "./commands/update.js";
import { STACK_IDS, type StackId } from "./config/types.js";
import { RepokeeperError, UsageError } from "./errors.js";
import type { GitHubApi } from "./github/api.js";
import { PACKAGE_VERSION } from "./version.js";

export interface Io {
  cwd: string;
  out(line: string): void;
  err(line: string): void;
  /** Asks a yes/no question; absent when nobody can answer (not a terminal). */
  confirm?(question: string): Promise<boolean>;
  /** GitHub API to use instead of the REST API; tests pass a fake. */
  githubApi?: GitHubApi;
}

export const USAGE = [
  "usage: repokeeper <command> [options]",
  "",
  "commands:",
  "  init    detect stacks, write .repokeeper.yml and apply the standard",
  "  check   report drift from the standard without writing (exit 1 on drift)",
  "  update  move to the standard of this repokeeper version and resync",
  "  github apply  diff the GitHub settings against .repokeeper.yml and apply them",
  "",
  "options:",
  "  --dry-run        show what would change without writing",
  "  --force          write even when target files have uncommitted changes",
  "  --adopt <path>   let repokeeper manage an existing file (repeatable); --adopt-all for every file",
  "  --accept <path>  take repokeeper's version of a locally edited file (update, repeatable)",
  "  --stack <id>     stack to use instead of detection (init, repeatable); id:folder for a stack in a folder",
  "  --platform <id>  github or gitlab, instead of detection from the origin remote (init)",
  "  --relock         rebuild .repokeeper/lock.json from the current files (init)",
  "  --json           machine-readable output (check)",
  "  -y, --yes        apply without asking (github apply)",
  "  -v, --version    print the version",
].join("\n");

const toPosix = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "");

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        "dry-run": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        adopt: { type: "string", multiple: true, default: [] },
        "adopt-all": { type: "boolean", default: false },
        accept: { type: "string", multiple: true, default: [] },
        stack: { type: "string", multiple: true, default: [] },
        platform: { type: "string" },
        relock: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        version: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }).valueOf() as { values: Record<string, unknown>; positionals: string[] };
    if (values.version) {
      io.out(PACKAGE_VERSION);
      return 0;
    }
    const [command] = positionals;
    if (values.help || command === undefined) {
      io.out(USAGE);
      return command === undefined && !values.help ? 2 : 0;
    }
    // `go:backend` names the folder of a monorepo the stack lives in
    const stackDirectories: Partial<Record<StackId, string>> = {};
    const stacks = (values.stack as string[]).map((value) => {
      const [stack, ...rest] = value.split(":");
      if (stack === undefined || !(STACK_IDS as readonly string[]).includes(stack)) {
        throw new UsageError(`unknown stack ${stack}; expected one of ${STACK_IDS.join(", ")}`);
      }
      const directory = toPosix(rest.join(":")).replace(/\/+$/, "");
      if (directory !== "" && directory !== ".") stackDirectories[stack as StackId] = directory;
      return stack;
    });
    const platform = values.platform as string | undefined;
    if (platform !== undefined && platform !== "github" && platform !== "gitlab") {
      throw new UsageError(`unknown platform ${platform}; expected github or gitlab`);
    }
    if (platform !== undefined && command !== "init") throw new UsageError("--platform is only for init");
    const options: CommandOptions = {
      dryRun: values["dry-run"] as boolean,
      force: values.force as boolean,
      adopt: (values.adopt as string[]).map(toPosix),
      adoptAll: values["adopt-all"] as boolean,
      accept: (values.accept as string[]).map(toPosix),
      stacks: stacks as StackId[],
      stackDirectories,
      relock: values.relock as boolean,
      json: values.json as boolean,
      yes: values.yes as boolean,
      ...(platform !== undefined ? { platform } : {}),
    };
    if (command === "init") return await initCommand(io.cwd, options, io);
    if (command === "check") return await checkCommand(io.cwd, options, io);
    if (command === "update") return await updateCommand(io.cwd, options, io);
    if (command === "github") {
      if (positionals[1] !== "apply") throw new UsageError("usage: repokeeper github apply [--dry-run] [--yes]");
      return await githubApplyCommand(io.cwd, options, io);
    }
    throw new UsageError(`unknown command: ${command}`);
  } catch (error) {
    if (error instanceof RepokeeperError) {
      io.err(`repokeeper: ${error.message}`);
      if (error instanceof UsageError) io.err(USAGE);
      return error.exitCode;
    }
    if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
      io.err(`repokeeper: ${error.message}`);
      io.err(USAGE);
      return 2;
    }
    throw error;
  }
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    ...(process.stdin.isTTY ? { confirm: askYesNo } : {}),
  }).then((code) => {
    process.exitCode = code;
  });
}
