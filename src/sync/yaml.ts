import { isDeepStrictEqual } from "node:util";
import { Document, isMap, isScalar, type Pair, parseDocument, type YAMLMap } from "yaml";
import { UsageError } from "../errors.js";
import { getAtPath } from "./json.js";

export interface YamlWriteOptions {
  /** Comment placed at the top of a file repokeeper creates. */
  header: string;
  /** Preferred order of top-level keys; keys not listed keep their relative order after them. */
  order?: readonly string[];
}

function parse(text: string, file: string): Document {
  const doc = parseDocument(text);
  const error = doc.errors[0];
  if (error) throw new UsageError(`${file} is not valid YAML: ${error.message.split("\n")[0]}`);
  return doc;
}

const renderLf = (doc: Document) => doc.toString({ lineWidth: 0, nullStr: "", flowCollectionPadding: false });
const withEol = (text: string, original: string | null) =>
  original?.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text;

/** JSON text of the value at `keyPath`, or null when the key is absent. */
export function readYamlKey(text: string, keyPath: string[], file: string): string | null {
  const value = getAtPath(parse(text, file).toJS() ?? {}, keyPath);
  return value === undefined ? null : JSON.stringify(value);
}

const keyName = (key: unknown) => String(isScalar(key) ? key.value : key);
const pairIn = (map: YAMLMap, key: string) => map.items.find((p) => keyName(p.key) === key) as Pair | undefined;

/** The block map at `keyPath` (the root for []); null when absent or written in flow style. */
function blockMap(doc: Document, keyPath: string[]): YAMLMap | null {
  const node = keyPath.length === 0 ? doc.contents : doc.getIn(keyPath, true);
  return isMap(node) && !node.flow ? node : null;
}

const lineStart = (text: string, offset: number) => text.lastIndexOf("\n", offset - 1) + 1;
function lineEnd(text: string, offset: number): number {
  const index = text.indexOf("\n", offset);
  return index === -1 ? text.length : index + 1;
}

type Range = [number, number, number];
const rangeOf = (node: unknown) => (node as { range?: Range } | null)?.range;

/** [start, end) of the whole lines a block-map pair occupies, and the column of its key. */
function pairSpan(text: string, pair: Pair): { start: number; end: number; column: number } | null {
  const key = rangeOf(pair.key);
  if (!key) return null;
  const last = Math.max((rangeOf(pair.value)?.[1] ?? key[1]) - 1, key[1]);
  const start = lineStart(text, key[0]);
  return { start, end: lineEnd(text, last), column: key[0] - start };
}

function reindent(lines: string, from: number, to: number): string {
  if (from === to) return lines;
  return lines
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      const strip = Math.min(from, line.length - line.trimStart().length);
      return " ".repeat(to) + line.slice(strip);
    })
    .join("\n");
}

/** The lines of the pair at `keyPath` in the rendered `doc`, indented to `column`. */
function renderedPair(doc: Document, keyPath: string[], column: number): string | null {
  const text = renderLf(doc);
  const parent = blockMap(parseDocument(text), keyPath.slice(0, -1));
  const pair = parent && pairIn(parent, keyPath[keyPath.length - 1] as string);
  const span = pair && pairSpan(text, pair);
  if (!span) return null;
  const lines = text.slice(span.start, span.end);
  return reindent(lines.endsWith("\n") ? lines : `${lines}\n`, span.column, column);
}

/**
 * Writes the key into `text` by editing only its own lines, so the rest of the file keeps its
 * formatting. Null when the file's shape doesn't allow it (flow collections, an empty map).
 */
function spliceSet(text: string, keyPath: string[], next: Document, order?: readonly string[]): string | null {
  const doc = parseDocument(text);
  let parent = blockMap(doc, []);
  let depth = 0;
  for (; parent && depth < keyPath.length; depth++) {
    const pair = pairIn(parent, keyPath[depth] as string);
    if (!pair) break;
    if (depth === keyPath.length - 1) {
      const span = pairSpan(text, pair);
      const lines = span && renderedPair(next, keyPath, span.column);
      return span && lines ? text.slice(0, span.start) + lines + text.slice(span.end) : null;
    }
    parent = isMap(pair.value) && !pair.value.flow ? pair.value : null;
  }
  const first = parent?.items[0];
  const firstSpan = first && pairSpan(text, first as Pair);
  if (!parent || !firstSpan) return null;
  const unit = keyPath.slice(0, depth + 1);
  const lines = renderedPair(next, unit, firstSpan.column);
  if (!lines) return null;

  let at: number | null = null;
  if (depth === 0 && order) {
    const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
    const after = parent.items.find((p) => rank(keyName(p.key)) > rank(unit[0] as string));
    if (after) at = pairSpan(text, after as Pair)?.start ?? null;
  }
  if (at === null) {
    const lastSpan = pairSpan(text, parent.items[parent.items.length - 1] as Pair);
    if (!lastSpan) return null;
    at = lastSpan.end;
  }
  const before = text.slice(0, at);
  return (before === "" || before.endsWith("\n") ? before : `${before}\n`) + lines + text.slice(at);
}

/** Removes the pair at `keyPath` plus the parents it leaves empty by cutting their lines. */
function spliceDelete(text: string, keyPath: string[]): string | null {
  const doc = parseDocument(text);
  let cut = keyPath.length;
  while (cut > 1 && blockMap(doc, keyPath.slice(0, cut - 1))?.items.length === 1) cut--;
  const parent = blockMap(doc, keyPath.slice(0, cut - 1));
  const pair = parent && pairIn(parent, keyPath[cut - 1] as string);
  const span = pair && pairSpan(text, pair);
  return span ? text.slice(0, span.start) + text.slice(span.end) : null;
}

/** The spliced text when it parses to exactly `expected`, otherwise a full re-render. */
function preferSplice(original: string, spliced: string | null, expected: Document): string {
  if (spliced !== null) {
    const check = parseDocument(spliced);
    if (check.errors.length === 0 && isDeepStrictEqual(check.toJS(), expected.toJS())) {
      return withEol(spliced, original);
    }
  }
  return withEol(renderLf(expected), original);
}

export function setYamlKey(
  text: string | null,
  file: string,
  keyPath: string[],
  value: unknown,
  options: YamlWriteOptions,
): string {
  const fresh = text === null || text.trim() === "";
  const lf = fresh ? "" : (text as string).replace(/\r\n/g, "\n");
  const doc = fresh ? new Document({}) : parse(lf, file);
  if (fresh) doc.commentBefore = ` ${options.header}`;
  doc.setIn(keyPath, doc.createNode(value));
  const order = options.order;
  if (order && isMap(doc.contents)) {
    const rank = (key: unknown) => {
      const index = order.indexOf(String(isScalar(key) ? key.value : key));
      return index === -1 ? order.length : index;
    };
    doc.contents.items.sort((a, b) => rank(a.key) - rank(b.key));
  }
  if (fresh) return withEol(renderLf(doc), text);
  return preferSplice(text as string, spliceSet(lf, keyPath, doc, order), doc);
}

/** Removes the key and any parents it leaves empty; null when nothing is left. */
export function deleteYamlKey(text: string, file: string, keyPath: string[]): string | null {
  const lf = text.replace(/\r\n/g, "\n");
  const doc = parse(lf, file);
  doc.deleteIn(keyPath);
  for (let depth = keyPath.length - 1; depth > 0; depth--) {
    const parent = doc.getIn(keyPath.slice(0, depth));
    if (!isMap(parent) || parent.items.length > 0) break;
    doc.deleteIn(keyPath.slice(0, depth));
  }
  if (!isMap(doc.contents) || doc.contents.items.length === 0) return null;
  return preferSplice(text, spliceDelete(lf, keyPath), doc);
}
