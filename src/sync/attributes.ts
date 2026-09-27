import { endMarker, startMarker } from "./block.js";
import { normalizeEol } from "./hash.js";

export interface OverriddenAttribute {
  /** The user's line, which git ignores for the attributes the block sets. */
  line: string;
  /** The block's line that wins because it comes later. */
  by: string;
}

/** `eol=lf` → ["eol", "lf"], `-text` → ["text", "unset"], `text` → ["text", "set"]. */
function attributes(fields: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const field of fields) {
    if (field.startsWith("-") || field.startsWith("!")) map.set(field.slice(1), "unset");
    else if (field.includes("=")) map.set(field.slice(0, field.indexOf("=")), field.slice(field.indexOf("=") + 1));
    else map.set(field, "set");
  }
  return map;
}

const parse = (line: string) => {
  const [pattern, ...fields] = line.trim().split(/\s+/);
  return { raw: line.trim(), pattern: pattern as string, attrs: attributes(fields) };
};
const isRule = (line: string) => line.trim() !== "" && !line.trim().startsWith("#");

/**
 * Lines above repokeeper's block that set an attribute the block sets differently for the same
 * pattern. gitattributes applies the last match, so those lines have no effect.
 */
export function overriddenAttributes(text: string, blockId: string): OverriddenAttribute[] {
  const lines = normalizeEol(text).split("\n");
  const start = lines.indexOf(startMarker(blockId, "hash"));
  const end = lines.indexOf(endMarker(blockId, "hash"), start + 1);
  if (start < 0 || end < 0) return [];
  const block = lines
    .slice(start + 1, end)
    .filter(isRule)
    .map(parse);
  const found: OverriddenAttribute[] = [];
  for (const line of lines.slice(0, start).filter(isRule)) {
    const mine = parse(line);
    const theirs = block.find(
      (rule) =>
        rule.pattern === mine.pattern &&
        [...mine.attrs].some(([key, value]) => rule.attrs.has(key) && rule.attrs.get(key) !== value),
    );
    if (theirs) found.push({ line: mine.raw, by: theirs.raw });
  }
  return found;
}
