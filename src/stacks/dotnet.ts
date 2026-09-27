import { UsageError } from "../errors.js";
import type { ReleaseInfo } from "../model.js";
import { checkKeys, filesMatching, readText, stringList } from "./support.js";
import type { StackPack } from "./types.js";

const OPTION_KEYS = ["versions", "os"];
const SOLUTIONS = /\.(sln|slnx)$/;
const PROJECTS = /\.(csproj|fsproj|vbproj)$/;
const VERSION_XPATH = "//Project/PropertyGroup/Version";

const versionOf = (xml: string | null) => (xml ? (/<Version>\s*([^<\s]+)\s*<\/Version>/.exec(xml)?.[1] ?? null) : null);

/** Project files the root solutions list, plus projects at the root, as posix paths. */
async function projectPaths(root: string, solutions: string[], projects: string[]): Promise<string[]> {
  const paths = new Set(projects);
  for (const solution of solutions) {
    const text = (await readText(root, solution)) ?? "";
    const pattern = solution.endsWith(".slnx") ? /Path="([^"]+\.[cfv][sb]proj)"/g : /"([^"]+\.[cfv][sb]proj)"/g;
    for (const match of text.matchAll(pattern)) paths.add((match[1] as string).replace(/\\/g, "/"));
  }
  return [...paths];
}

/** SDK-style projects name an SDK; .NET Framework projects don't, and the dotnet CLI can't build them. */
const isSdkStyle = (xml: string) => /<Project[^>]*\sSdk=/.test(xml) || /<Sdk\s+Name=/.test(xml);

export const dotnetStack: StackPack = {
  id: "dotnet",
  detect: (root) => filesMatching(root, ".", SOLUTIONS).length + filesMatching(root, ".", PROJECTS).length > 0,
  async resolve(root, options = {}) {
    checkKeys("dotnet", options, OPTION_KEYS);
    const solutions = filesMatching(root, ".", SOLUTIONS);
    const projects = filesMatching(root, ".", PROJECTS);
    // with several entries at the root, dotnet stops with MSB1011 unless one is named
    const target = solutions.length + projects.length > 1 ? ` ${solutions[0] ?? projects[0]}` : "";

    const legacy: string[] = [];
    for (const path of await projectPaths(root, solutions, projects)) {
      const xml = await readText(root, path);
      if (xml !== null && /<Project[\s>]/.test(xml) && !isSdkStyle(xml)) legacy.push(path);
    }
    if (legacy.length > 0) {
      throw new UsageError(
        `the dotnet stack needs SDK-style projects, and ${legacy.join(", ")} ${legacy.length > 1 ? "are" : "is"} .NET Framework projects the dotnet CLI can't build; convert them (for example with the .NET Upgrade Assistant) or leave dotnet out of stacks`,
      );
    }

    let release: ReleaseInfo = { type: "simple", version: null };
    for (const file of ["Directory.Build.props", ...(projects.length === 1 ? projects : [])]) {
      const version = versionOf(await readText(root, file));
      if (version) {
        release = { type: "simple", version, extraFiles: [{ type: "xml", path: file, xpath: VERSION_XPATH }] };
        break;
      }
    }
    return {
      id: "dotnet",
      staged: [{ name: "dotnet:format", glob: "*.{cs,vb,fs}", run: `dotnet format${target} --include {staged_files}` }],
      test: `dotnet test${target}`,
      install: `dotnet restore${target}`,
      gitignore: ["VisualStudio"],
      dependabot: ["nuget"],
      ci: {
        workflow: "stack-dotnet.yml",
        with: {
          "dotnet-versions": JSON.stringify(stringList("dotnet", options, "versions") ?? ["8.0", "9.0"]),
          os: JSON.stringify(stringList("dotnet", options, "os") ?? ["ubuntu-latest"]),
          commands: JSON.stringify([
            `dotnet restore${target}`,
            `dotnet format${target} --verify-no-changes --no-restore`,
            `dotnet build${target} --no-restore`,
            `dotnet test${target} --no-build`,
          ]),
        },
      },
      release,
    };
  },
};
