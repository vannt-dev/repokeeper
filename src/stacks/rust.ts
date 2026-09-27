import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseInfo } from "../model.js";
import { checkKeys, readText, stringList, tomlSection } from "./support.js";
import type { StackPack } from "./types.js";

const OPTION_KEYS = ["versions", "os"];

export const rustStack: StackPack = {
  id: "rust",
  detect: (root) => existsSync(join(root, "Cargo.toml")),
  async resolve(root, options = {}) {
    checkKeys("rust", options, OPTION_KEYS);
    const cargo = (await readText(root, "Cargo.toml")) ?? "";
    const pkg = tomlSection(cargo, "package");
    const version = /^version\s*=\s*"([^"]+)"/m.exec(pkg)?.[1] ?? null;
    // a workspace root without its own package has nothing for release-please's rust updater to bump
    const release: ReleaseInfo = pkg ? { type: "rust", version } : { type: "simple", version: null };
    return {
      id: "rust",
      staged: [{ name: "rust:fmt", glob: "*.rs", run: "cargo fmt --all" }],
      test: "cargo test",
      install: "cargo fetch",
      gitignore: ["Rust"],
      dependabot: ["cargo"],
      ci: {
        workflow: "stack-rust.yml",
        with: {
          "rust-versions": JSON.stringify(stringList("rust", options, "versions") ?? ["stable"]),
          os: JSON.stringify(stringList("rust", options, "os") ?? ["ubuntu-latest"]),
          commands: JSON.stringify([
            "cargo fmt --all --check",
            "cargo clippy --all-targets -- -D warnings",
            "cargo test --all-targets",
          ]),
        },
      },
      release,
    };
  },
};
