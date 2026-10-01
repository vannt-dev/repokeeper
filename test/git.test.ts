import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { dirtyPaths, isGitRepo, parseRemote, parseRemoteUrl, remoteHost, repoInfo } from "../src/git.js";
import { tempDir } from "./helpers.js";

it("parses GitHub remotes in HTTPS and SSH form", () => {
  expect(parseRemoteUrl("https://github.com/vannt-dev/repokeeper.git")).toEqual({
    owner: "vannt-dev",
    name: "repokeeper",
  });
  expect(parseRemoteUrl("git@github.com:vannt-dev/repokeeper.git\n")).toEqual({
    owner: "vannt-dev",
    name: "repokeeper",
  });
  expect(parseRemoteUrl("https://gitlab.com/a/b.git")).toBeNull();
});

it("falls back to the directory name outside git", async () => {
  const dir = await tempDir();
  expect(await isGitRepo(dir)).toBe(false);
  expect((await repoInfo(dir)).owner).toBeNull();
  expect(await dirtyPaths(dir, ["a.txt"])).toEqual([]);
});

it("lists modified and untracked files among the given paths", async () => {
  const dir = await tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "a");
  await writeFile(join(dir, "b.txt"), "b");
  expect(await dirtyPaths(dir, ["a.txt", "c.txt"])).toEqual([{ path: "a.txt", untracked: true }]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "a.txt"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "changed");
  expect(await dirtyPaths(dir, ["a.txt", "b.txt"])).toEqual([
    { path: "a.txt", untracked: false },
    { path: "b.txt", untracked: true },
  ]);
});

it("parses GitLab remotes with nested groups, credentials, ports and self-hosted hosts", () => {
  expect(parseRemote("https://gitlab.com/acme/tools/demo.git")).toEqual({
    host: "gitlab.com",
    owner: "acme/tools",
    name: "demo",
  });
  expect(parseRemote("git@gitlab.com:acme/demo.git\n")).toEqual({ host: "gitlab.com", owner: "acme", name: "demo" });
  expect(parseRemote("ssh://git@GitLab.Example.com:2222/acme/tools/sub/demo.git")).toEqual({
    host: "gitlab.example.com",
    owner: "acme/tools/sub",
    name: "demo",
  });
  expect(parseRemote("https://oauth2:secret@gitlab.com/acme/demo/")).toEqual({
    host: "gitlab.com",
    owner: "acme",
    name: "demo",
  });
});

it("rejects remotes without a host and a namespace", () => {
  for (const url of ["C:/work/demo", "file:///srv/git/demo.git", "../demo", "https://gitlab.com/demo.git", ""]) {
    expect(parseRemote(url)).toBeNull();
  }
});

it("reads the repository from a GitLab remote only on the gitlab platform", async () => {
  const dir = await tempDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@gitlab.example.com:acme/tools/demo.git"], { cwd: dir });

  expect(await remoteHost(dir)).toBe("gitlab.example.com");
  expect(await repoInfo(dir, "gitlab")).toMatchObject({
    host: "gitlab.example.com",
    owner: "acme/tools",
    name: "demo",
  });
  expect((await repoInfo(dir)).owner).toBeNull();
  expect(await remoteHost(await tempDir())).toBeNull();
});

it("keeps the port of an HTTPS remote, which the web address shares, and drops an SSH port", () => {
  expect(parseRemote("https://gitlab.example.com:8443/acme/demo.git")?.host).toBe("gitlab.example.com:8443");
  expect(parseRemote("http://gitlab.example.com:8080/acme/demo.git")?.host).toBe("gitlab.example.com:8080");
  expect(parseRemote("ssh://git@gitlab.example.com:2222/acme/demo.git")?.host).toBe("gitlab.example.com");
});
