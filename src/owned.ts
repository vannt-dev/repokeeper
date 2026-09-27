import type { Target } from "./sync/lock.js";

const toPosix = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * Whether an `owned` entry covers the target: a whole path (`LICENSE`), a block (`.gitattributes#editorconfig`),
 * or a key and everything under it (`.github/workflows/ci.yml#on`, `package.json#devDependencies.lefthook`).
 */
export function isOwned(owned: readonly string[], target: Target): boolean {
  return owned.some((entry) => {
    const hash = entry.indexOf("#");
    const path = toPosix(hash === -1 ? entry : entry.slice(0, hash));
    if (path !== target.path) return false;
    if (hash === -1) return true;
    const key = entry.slice(hash + 1);
    if (target.kind === "block") return key === target.id;
    if (target.kind === "yaml" || target.kind === "json") {
      const dotted = target.keyPath.join(".");
      return dotted === key || dotted.startsWith(`${key}.`);
    }
    return false;
  });
}
