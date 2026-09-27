import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE } from "../config/load.js";
import type { StackId } from "../config/types.js";
import { ConfigError } from "../errors.js";
import type { StackOptions } from "./types.js";

export function checkKeys(stack: StackId, options: StackOptions, keys: readonly string[]): void {
  for (const key of Object.keys(options)) {
    if (!keys.includes(key)) {
      throw new ConfigError(`${CONFIG_FILE}: stack_options.${stack}.${key} is not a known key (${keys.join(", ")})`);
    }
  }
}

/** A list option; YAML numbers such as `[22, 24]` count as strings. */
export function stringList(stack: StackId, options: StackOptions, key: string): string[] | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  const valid =
    Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" || typeof v === "number");
  if (!valid)
    throw new ConfigError(`${CONFIG_FILE}: stack_options.${stack}.${key} must be a non-empty list of strings`);
  return value.map(String);
}

export function optionalString(stack: StackId, options: StackOptions, key: string): string | undefined {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${CONFIG_FILE}: stack_options.${stack}.${key} must be a non-empty string`);
  }
  return value;
}

/** Names of the entries of `dir` (relative to root) matching `pattern`, sorted; empty when `dir` is missing. */
export function filesMatching(root: string, dir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(join(root, dir))
      .filter((name) => pattern.test(name))
      .sort();
  } catch {
    return [];
  }
}

export async function readText(root: string, file: string): Promise<string | null> {
  try {
    return await readFile(join(root, file), "utf8");
  } catch {
    return null;
  }
}

/** The body of the `[name]` table of a TOML file, or "". */
export function tomlSection(toml: string, name: string): string {
  return toml.split(/^\[/m).find((part) => part.startsWith(`${name}]`)) ?? "";
}
