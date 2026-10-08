import { readdirSync } from "node:fs";
import { join } from "node:path";
import { STACK_IDS, type StackId } from "../config/types.js";
import { dartStack } from "./dart.js";
import { dotnetStack } from "./dotnet.js";
import { goStack } from "./go.js";
import { javaStack } from "./java.js";
import { kotlinStack } from "./kotlin.js";
import { nodeStack } from "./node.js";
import { phpStack } from "./php.js";
import { pythonStack } from "./python.js";
import { rubyStack } from "./ruby.js";
import { rustStack } from "./rust.js";
import { scriptStack } from "./script.js";
import type { StackPack } from "./types.js";

const PACKS: Record<StackId, StackPack> = {
  node: nodeStack,
  python: pythonStack,
  dart: dartStack,
  script: scriptStack,
  java: javaStack,
  dotnet: dotnetStack,
  go: goStack,
  rust: rustStack,
  kotlin: kotlinStack,
  php: phpStack,
  ruby: rubyStack,
};

export function getStackPack(id: StackId): StackPack {
  return PACKS[id];
}

export async function detectStacks(root: string): Promise<StackId[]> {
  let found = STACK_IDS.filter((id) => PACKS[id].detect(root));
  // a Kotlin build is also a Gradle build; one CI job runs it
  if (found.includes("kotlin")) found = found.filter((id) => id !== "java");
  // scripts beside another stack belong to that stack; the script pack is for script-only repositories
  return found.length > 1 ? found.filter((id) => id !== "script") : found;
}

/** Folders that hold a project's by-products or samples rather than a project of the repository. */
const NOT_A_PROJECT = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "out",
  "bin",
  "obj",
  "coverage",
  "example",
  "examples",
  "test",
  "tests",
  "fixtures",
  "doc",
  "docs",
]);

export interface StackLayout {
  stacks: StackId[];
  /** Folder of each stack that is not at the root. */
  directories: Partial<Record<StackId, string>>;
  /** Folders left out because their stack already has a folder: one folder per stack. */
  skipped: Array<{ stack: StackId; directory: string }>;
}

/**
 * The stacks of a repository and where they are: at the root or, when the root holds no project
 * (a monorepo such as frontend/ and backend/), in its immediate folders.
 */
export async function detectStackLayout(root: string): Promise<StackLayout> {
  const atRoot = await detectStacks(root);
  const rooted: StackLayout = { stacks: atRoot, directories: {}, skipped: [] };
  // loose scripts at the root do not make it a project: a monorepo often keeps some beside its folders
  if (atRoot.some((id) => id !== "script")) return rooted;

  const directories: Partial<Record<StackId, string>> = {};
  const skipped: StackLayout["skipped"] = [];
  const folders = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !NOT_A_PROJECT.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    for (const id of await detectStacks(join(root, folder))) {
      if (directories[id] === undefined) directories[id] = folder;
      else skipped.push({ stack: id, directory: folder });
    }
  }
  let stacks = STACK_IDS.filter((id) => directories[id] !== undefined);
  // nothing but scripts in the folders either: the root's own answer stands
  if (atRoot.length > 0 && stacks.every((id) => id === "script")) return rooted;
  // as at the root: a folder of scripts beside real projects is tooling, not a stack
  if (stacks.length > 1 && directories.script !== undefined) {
    stacks = stacks.filter((id) => id !== "script");
    delete directories.script;
  }
  return { stacks, directories, skipped: skipped.filter((entry) => stacks.includes(entry.stack)) };
}
