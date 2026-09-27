import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkKeys, stringList } from "./support.js";
import type { StackPack } from "./types.js";

const OPTION_KEYS = ["versions", "os"];
const GOFMT = 'test -z "$(gofmt -l .)" || { gofmt -l .; exit 1; }';

export const goStack: StackPack = {
  id: "go",
  detect: (root) => existsSync(join(root, "go.mod")),
  async resolve(_root, options = {}) {
    checkKeys("go", options, OPTION_KEYS);
    return {
      id: "go",
      staged: [{ name: "go:gofmt", glob: "*.go", run: "gofmt -w {staged_files}" }],
      test: "go test ./...",
      install: "go mod download",
      gitignore: ["Go"],
      dependabot: ["gomod"],
      ci: {
        workflow: "stack-go.yml",
        with: {
          "go-versions": JSON.stringify(stringList("go", options, "versions") ?? ["stable"]),
          os: JSON.stringify(stringList("go", options, "os") ?? ["ubuntu-latest"]),
          commands: JSON.stringify([GOFMT, "go vet ./...", "go test ./..."]),
        },
      },
      // Go modules are versioned by their tags; the manifest starts from the latest one
      release: { type: "go", version: null },
    };
  },
};
