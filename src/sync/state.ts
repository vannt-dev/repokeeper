import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UsageError } from "../errors.js";
import type { Output } from "../model.js";
import { readBlock } from "./block.js";
import { getAtPath } from "./json.js";
import type { Target } from "./lock.js";
import { markerState } from "./marker.js";
import { readYamlKey } from "./yaml.js";

/** The text repokeeper compares and hashes for an output. */
export function desiredText(output: Output): string {
  if (output.kind === "file") return output.content;
  // a seed only has to exist, so present content always compares equal
  if (output.kind === "seed" || output.kind === "marker") return "";
  if (output.kind === "block") return output.body;
  return JSON.stringify(output.value);
}

async function readText(root: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The same comparable text read from disk, or null when absent. */
export async function readCurrent(root: string, target: Target): Promise<string | null> {
  const text = await readText(root, target.path);
  // markers are added to a file the user owns; a missing file or line means there is nothing to add
  if (target.kind === "marker") return markerState(text, target.line);
  if (text === null) return null;
  if (target.kind === "file") return text;
  if (target.kind === "seed") return "";
  if (target.kind === "block") return readBlock(text, target.id, target.comment);
  if (target.kind === "yaml") return readYamlKey(text, target.keyPath, target.path);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${target.path} is not valid JSON: ${(error as Error).message}`);
  }
  const value = getAtPath(data, target.keyPath);
  return value === undefined ? null : JSON.stringify(value);
}
