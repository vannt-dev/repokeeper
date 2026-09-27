import { STACK_IDS, type StackId } from "../config/types.js";
import { dartStack } from "./dart.js";
import { dotnetStack } from "./dotnet.js";
import { goStack } from "./go.js";
import { javaStack } from "./java.js";
import { kotlinStack } from "./kotlin.js";
import { nodeStack } from "./node.js";
import { pythonStack } from "./python.js";
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
