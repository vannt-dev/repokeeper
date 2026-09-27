import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { dotnetStack } from "../src/stacks/dotnet.js";
import { tempDir } from "./helpers.js";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}
const PROPS = "<Project>\n  <PropertyGroup>\n    <Version>1.5.0</Version>\n  </PropertyGroup>\n</Project>\n";

it("is detected from a solution or project file at the root", async () => {
  expect(dotnetStack.detect(await repo({ "App.sln": "" }))).toBe(true);
  expect(dotnetStack.detect(await repo({ "App.csproj": "" }))).toBe(true);
  expect(dotnetStack.detect(await repo({ "Program.cs": "" }))).toBe(false);
});

it("restores, checks formatting, builds and tests, and releases through Directory.Build.props", async () => {
  const stack = await dotnetStack.resolve(await repo({ "App.sln": "", "Directory.Build.props": PROPS }));
  expect(stack.ci).toEqual({
    workflow: "stack-dotnet.yml",
    with: {
      "dotnet-versions": '["8.0","9.0"]',
      os: '["ubuntu-latest"]',
      commands:
        '["dotnet restore","dotnet format --verify-no-changes --no-restore","dotnet build --no-restore","dotnet test --no-build"]',
    },
  });
  expect(stack.staged).toEqual([
    { name: "dotnet:format", glob: "*.{cs,vb,fs}", run: "dotnet format --include {staged_files}" },
  ]);
  expect(stack.test).toBe("dotnet test");
  expect(stack.install).toBe("dotnet restore");
  expect(stack.gitignore).toEqual(["VisualStudio"]);
  expect(stack.dependabot).toEqual(["nuget"]);
  expect(stack.release).toEqual({
    type: "simple",
    version: "1.5.0",
    extraFiles: [{ type: "xml", path: "Directory.Build.props", xpath: "//Project/PropertyGroup/Version" }],
  });
});

it("names the first solution when several project files sit at the root", async () => {
  const stack = await dotnetStack.resolve(await repo({ "B.sln": "", "A.sln": "", "Tool.csproj": "" }));
  expect(JSON.parse(stack.ci?.with.commands ?? "")[0]).toBe("dotnet restore A.sln");
  expect(stack.test).toBe("dotnet test A.sln");
  expect(stack.release).toEqual({ type: "simple", version: null });
});

it("reads the version of a single project file", async () => {
  const stack = await dotnetStack.resolve(
    await repo({ "Lib.csproj": PROPS.replace("<Project>", '<Project Sdk="Microsoft.NET.Sdk">') }),
  );
  expect(stack.release).toEqual({
    type: "simple",
    version: "1.5.0",
    extraFiles: [{ type: "xml", path: "Lib.csproj", xpath: "//Project/PropertyGroup/Version" }],
  });
});

it("refuses .NET Framework projects the dotnet CLI can't build, naming them", async () => {
  const dir = await repo({ "Shop.sln": "" });
  await mkdir(join(dir, "Shop"));
  await writeFile(
    join(dir, "Shop.sln"),
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Shop", "Shop\\Shop.csproj", "{1}"\nEndProject\n',
  );
  await writeFile(join(dir, "Shop/Shop.csproj"), '<Project ToolsVersion="14.0" DefaultTargets="Build">\n</Project>\n');
  await expect(dotnetStack.resolve(dir)).rejects.toThrow("Shop/Shop.csproj");

  const sdk = await repo({ "App.slnx": '<Solution>\n  <Project Path="src/App/App.csproj" />\n</Solution>\n' });
  await mkdir(join(sdk, "src/App"), { recursive: true });
  await writeFile(join(sdk, "src/App/App.csproj"), '<Project Sdk="Microsoft.NET.Sdk">\n</Project>\n');
  expect((await dotnetStack.resolve(sdk)).ci?.workflow).toBe("stack-dotnet.yml");
});
