import { CONFIG_FILE } from "../config/load.js";
import { ConfigError } from "../errors.js";
import { checkKeys, filesMatching, stringList } from "./support.js";
import type { StackPack } from "./types.js";

const OPTION_KEYS = ["files", "build"];

/** A recipe for an image: `Dockerfile`, `Containerfile`, either with a suffix, or `<name>.Dockerfile`. */
const isDockerfile = (name: string) =>
  // `Dockerfile.dockerignore` is the ignore file of the Dockerfile beside it
  !name.endsWith(".dockerignore") && (/^(Dockerfile|Containerfile)(\..+)?$/.test(name) || /\.dockerfile$/i.test(name));

const dockerfiles = (root: string) => filesMatching(root, ".", /./).filter(isDockerfile);

const COMPOSE_FILE = /^(docker-)?compose\.ya?ml$/;

export const dockerStack: StackPack = {
  id: "docker",
  detect: (root) => dockerfiles(root).length > 0,
  async resolve(root, options = {}) {
    checkKeys("docker", options, OPTION_KEYS);
    if (options.build !== undefined && typeof options.build !== "boolean") {
      throw new ConfigError(`${CONFIG_FILE}: stack_options.docker.build must be true or false`);
    }
    return {
      id: "docker",
      // hadolint is rarely installed locally; CI enforces it
      staged: [],
      test: null,
      install: null,
      gitignore: [],
      dependabot: filesMatching(root, ".", COMPOSE_FILE).length > 0 ? ["docker", "docker-compose"] : ["docker"],
      ci: {
        workflow: "stack-docker.yml",
        with: {
          dockerfiles: JSON.stringify(stringList("docker", options, "files") ?? dockerfiles(root)),
          // off by default: a build may need a context, arguments or secrets a lint does not
          build: String(options.build === true),
        },
      },
      release: { type: "simple", version: null },
    };
  },
};
