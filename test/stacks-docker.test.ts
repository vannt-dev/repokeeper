import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { stackJobs } from "../src/platforms/gitlab-jobs.js";
import { dockerStack } from "../src/stacks/docker.js";
import { detectStackLayout, detectStacks } from "../src/stacks/index.js";
import { tempDir } from "./helpers.js";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

const FROM = "FROM alpine:3.22\n";

describe("docker stack", () => {
  it("is detected from a Dockerfile or a Containerfile, whatever it is named after", async () => {
    for (const name of ["Dockerfile", "Containerfile", "Dockerfile.dev", "api.Dockerfile", "worker.dockerfile"]) {
      expect(dockerStack.detect(await repo({ [name]: FROM })), name).toBe(true);
    }
    // files about images that are not a recipe for one
    for (const name of [
      "Dockerfile.dockerignore",
      ".dockerignore",
      "compose.yaml",
      "docker-compose.yml",
      "README.md",
    ]) {
      expect(dockerStack.detect(await repo({ [name]: "" })), name).toBe(false);
    }
  });

  it("lints every Dockerfile at its root with hadolint, and builds nothing unless asked", async () => {
    const stack = await dockerStack.resolve(
      await repo({
        Dockerfile: FROM,
        "Dockerfile.dev": FROM,
        "worker.Dockerfile": FROM,
        "Dockerfile.dockerignore": "",
        "docs/Dockerfile": FROM,
      }),
    );
    expect(stack.ci).toEqual({
      workflow: "stack-docker.yml",
      with: { dockerfiles: '["Dockerfile","Dockerfile.dev","worker.Dockerfile"]', build: "false" },
    });
    // hadolint is rarely installed locally; CI enforces it
    expect(stack.staged).toEqual([]);
    expect(stack.test).toBeNull();
    expect(stack.install).toBeNull();
    expect(stack.gitignore).toEqual([]);
    expect(stack.dependabot).toEqual(["docker"]);
    expect(stack.release).toEqual({ type: "simple", version: null });
  });

  it("keeps the images of a compose file up to date too, when there is one", async () => {
    for (const name of ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"]) {
      const stack = await dockerStack.resolve(await repo({ Dockerfile: FROM, [name]: "services: {}\n" }));
      expect(stack.dependabot, name).toEqual(["docker", "docker-compose"]);
    }
  });

  it("takes the files and the build from stack_options", async () => {
    const root = await repo({ Dockerfile: FROM, "docker/app.Dockerfile": FROM });
    const stack = await dockerStack.resolve(root, { files: ["docker/app.Dockerfile"], build: true });
    expect(stack.ci?.with).toEqual({ dockerfiles: '["docker/app.Dockerfile"]', build: "true" });

    await expect(dockerStack.resolve(root, { push: true })).rejects.toThrow(
      "stack_options.docker.push is not a known key",
    );
    await expect(dockerStack.resolve(root, { build: "yes" })).rejects.toThrow(
      "stack_options.docker.build must be true or false",
    );
    await expect(dockerStack.resolve(root, { files: [] })).rejects.toThrow(
      "stack_options.docker.files must be a non-empty list of strings",
    );
  });
});

describe("the docker job on GitLab", () => {
  it("names a file the shell would split or end as one word", async () => {
    const stack = await dockerStack.resolve(await repo({ Dockerfile: FROM }), {
      files: ["Dockerfile", "my app.Dockerfile", "it's.Dockerfile"],
    });
    const script = (stackJobs(stack)[0]?.job.script ?? []) as string[];
    expect(script[0]).toContain(
      `else hadolint --failure-threshold warning Dockerfile 'my app.Dockerfile' 'it'\\''s.Dockerfile'; fi`,
    );
  });
});

describe("detection with a Dockerfile", () => {
  it("keeps the docker stack beside another one: a Dockerfile is linted wherever it is", async () => {
    expect(await detectStacks(await repo({ "package.json": "{}", Dockerfile: FROM }))).toEqual(["node", "docker"]);
    expect(await detectStacks(await repo({ Dockerfile: FROM }))).toEqual(["docker"]);
  });

  it("lints the scripts of a repository that is only an image, and leaves them to a project otherwise", async () => {
    // an image and its entrypoint: there is no project for the scripts to belong to
    expect(await detectStacks(await repo({ Dockerfile: FROM, "entrypoint.sh": "" }))).toEqual(["script", "docker"]);
    expect(await detectStacks(await repo({ "go.mod": "module a\n", Dockerfile: FROM, "run.sh": "" }))).toEqual([
      "go",
      "docker",
    ]);
  });

  it("still looks into the folders of a monorepo that has a Dockerfile at its root", async () => {
    const layout = await detectStackLayout(
      await repo({ Dockerfile: FROM, "web/package.json": "{}", "api/go.mod": "module a\n" }),
    );
    // the root's Dockerfile stays a stack at the root
    expect(layout.stacks).toEqual(["node", "go", "docker"]);
    expect(layout.directories).toEqual({ node: "web", go: "api" });
  });

  it("takes a Dockerfile in a folder with that folder, and reports a second one", async () => {
    const layout = await detectStackLayout(
      await repo({
        "api/go.mod": "module a\n",
        "api/Dockerfile": FROM,
        "web/package.json": "{}",
        "web/Dockerfile": FROM,
      }),
    );
    expect(layout.stacks).toEqual(["node", "go", "docker"]);
    expect(layout.directories).toEqual({ node: "web", go: "api", docker: "api" });
    expect(layout.skipped).toEqual([{ stack: "docker", directory: "web" }]);
  });

  it("leaves a root that is only an image as it is, whatever is beside it", async () => {
    const layout = await detectStackLayout(await repo({ Dockerfile: FROM, "tools/build.sh": "" }));
    expect(layout).toEqual({ stacks: ["docker"], directories: {}, skipped: [] });
  });
});
