import { MANAGED_HEADER, type Module } from "../model.js";

const EDITORCONFIG = `# ${MANAGED_HEADER}
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.{cs,csx,vb,fs,fsx,fsi,py}]
indent_size = 4

[*.{bat,cmd}]
end_of_line = crlf

[*.md]
trim_trailing_whitespace = false

[Makefile]
indent_style = tab
`;

// gitattributes patterns have no brace expansion, so every extension gets its own line.
// No rule converts to CRLF: the Claude plugin directory refuses a repository whose .gitattributes
// does (installed files could differ from the scanned ones). PowerShell runs LF files; .bat and .cmd
// need CRLF to run, so git keeps them byte for byte (-text) as the editor wrote them.
const LF_SCRIPTS = ["ps1", "psm1"];
const KEEP_BYTES = ["bat", "cmd"];
const BINARY = ["png", "jpg", "jpeg", "gif", "ico", "webp", "pdf", "zip", "gz", "woff", "woff2"];
const GITATTRIBUTES = [
  "* text=auto eol=lf",
  ...LF_SCRIPTS.map((ext) => `*.${ext} text eol=lf`),
  ...KEEP_BYTES.map((ext) => `*.${ext} -text`),
  ...BINARY.map((ext) => `*.${ext} binary`),
].join("\n");

export const editorconfigModule: Module = {
  id: "editorconfig",
  enabled: (config) => config.modules.editorconfig,
  outputs: () => [
    { kind: "file", module: "editorconfig", path: ".editorconfig", content: EDITORCONFIG },
    {
      kind: "block",
      module: "editorconfig",
      path: ".gitattributes",
      id: "editorconfig",
      comment: "hash",
      body: GITATTRIBUTES,
    },
  ],
};
