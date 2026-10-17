/**
 * One POSIX extended regular expression, anchored, that matches a path when any of the globs
 * does. The globs read as GitHub's path filters do: `*` is any run of characters within one path
 * segment, `**` any depth (and `**` with a slash after it, no directory or any), `?` one
 * character other than `/`.
 */
export function globsToRegex(globs: string[]): string {
  return `^(${globs.map(globToRegex).join("|")})$`;
}

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += /[.+^$()[\]{}|\\]/.test(char) ? `\\${char}` : char;
    }
  }
  return out;
}
