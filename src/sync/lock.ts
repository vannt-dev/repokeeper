import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LockError } from "../errors.js";
import type { Output } from "../model.js";
import type { CommentStyle } from "./block.js";

export const LOCK_FILE = ".repokeeper/lock.json";

export type Target =
  | { kind: "file"; path: string }
  | { kind: "seed"; path: string }
  | { kind: "block"; path: string; id: string; comment: CommentStyle }
  | { kind: "json"; path: string; keyPath: string[] }
  | { kind: "yaml"; path: string; keyPath: string[] }
  | { kind: "marker"; path: string; line: string };

export function targetOf(output: Output): Target {
  if (output.kind === "marker") return { kind: "marker", path: output.path, line: output.line };
  if (output.kind === "file") return { kind: "file", path: output.path };
  if (output.kind === "seed") return { kind: "seed", path: output.path };
  if (output.kind === "block") return { kind: "block", path: output.path, id: output.id, comment: output.comment };
  if (output.kind === "yaml") return { kind: "yaml", path: output.path, keyPath: output.keyPath };
  return { kind: "json", path: output.path, keyPath: output.keyPath };
}

export interface LockEntry {
  id: string;
  module: string;
  /** Hash of the content repokeeper last wrote (see desiredText). */
  hash: string;
  target: Target;
}

export interface Lock {
  lockVersion: 1;
  standard: string;
  entries: LockEntry[];
}

export async function readLock(root: string): Promise<Lock | null> {
  let text: string;
  try {
    text = await readFile(join(root, LOCK_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const data = JSON.parse(text) as Lock;
    if (data.lockVersion !== 1 || !Array.isArray(data.entries)) throw new Error("unexpected format");
    return data;
  } catch (error) {
    throw new LockError(`${LOCK_FILE} is unreadable (${(error as Error).message}); run \`repokeeper init --relock\``);
  }
}

export async function writeLock(root: string, lock: Lock): Promise<void> {
  const path = join(root, LOCK_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
}
