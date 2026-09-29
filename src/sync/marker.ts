/** release-please's block markers for a version in a file its generic updater edits. */
export const MARKER_START = "# x-release-please-start-version";
export const MARKER_END = "# x-release-please-end";

const HAS_MARKERS = /x-release-please-(start-version|version)\b/;
const UNMARKED = "unmarked";

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function lineIndex(lines: string[], line: string): number {
  const pattern = new RegExp(line);
  return lines.findIndex((l) => pattern.test(l));
}

/** "" when there is nothing to add (no file, no matching line, or markers already present), else "unmarked". */
export function markerState(text: string | null, line: string): string {
  if (text === null || HAS_MARKERS.test(text)) return "";
  return lineIndex(text.split(eolOf(text)), line) === -1 ? "" : UNMARKED;
}

/** The text with block markers around the first line matching `line`; unchanged when there is nothing to add. */
export function addMarkers(text: string, line: string): string {
  if (markerState(text, line) === "") return text;
  const eol = eolOf(text);
  const lines = text.split(eol);
  const index = lineIndex(lines, line);
  lines.splice(index, 1, MARKER_START, lines[index] as string, MARKER_END);
  return lines.join(eol);
}
