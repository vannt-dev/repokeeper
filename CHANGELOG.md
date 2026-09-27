# Changelog

## [0.2.0](https://github.com/vannt-dev/repokeeper/compare/v0.1.0...v0.2.0) (2026-09-26)


### Features

* **cli:** add init, check and update commands ([b8ffeb8](https://github.com/vannt-dev/repokeeper/commit/b8ffeb8dab7e35adcf90ad3f02b99edf8173a708))
* **cli:** add the project skeleton and version command ([bb03df3](https://github.com/vannt-dev/repokeeper/commit/bb03df3acf7eef2cea70b6c8c53cf3b0ef4cae33))
* **config:** load and validate .repokit.yml with line-level errors ([6f22739](https://github.com/vannt-dev/repokeeper/commit/6f227395190179554e02efda384e2f003f647911))
* **modules:** add community health files and Dependabot through the GitHub adapter ([78dbdd9](https://github.com/vannt-dev/repokeeper/commit/78dbdd9fbdef90d01b31f8584714dc1035552caf))
* **modules:** add editorconfig, gitignore, commitlint and lefthook modules ([dda951d](https://github.com/vannt-dev/repokeeper/commit/dda951d16588da08de0f91c38f1b30e2b52da9ae))
* **modules:** add release-please automation and move the standard to 1.1.0 ([3e05072](https://github.com/vannt-dev/repokeeper/commit/3e050725a0997df3ca7f1b113ec78be878b10dfe))
* **modules:** add the ci module that calls the reusable workflows ([dea09a9](https://github.com/vannt-dev/repokeeper/commit/dea09a9d0b2c9b0e1beab45f68db1e5a4ffe5e86))
* move the standard to 1.2.0 and record the stack pack decisions in the spec ([90318cd](https://github.com/vannt-dev/repokeeper/commit/90318cddba2f68b81b54b1ce35b42cf2f6215721))
* **plan:** combine enabled modules into one deterministic output list ([1782232](https://github.com/vannt-dev/repokeeper/commit/1782232c7de440883ac3d25caefdce8a2b04d897))
* python, dart, script, java and dotnet stack packs ([c4c6197](https://github.com/vannt-dev/repokeeper/commit/c4c619771325f246766ba44a6dfb40ae16b69f2c))
* repokeeper core (init, check, update for Node repositories) ([8fbe33e](https://github.com/vannt-dev/repokeeper/commit/8fbe33ee699e3ad1b3a9be4132d24fca5403adb3))
* reusable workflows, ci and release modules ([fd1b99c](https://github.com/vannt-dev/repokeeper/commit/fd1b99c2590dee8ad4e9f78532affcd774bb6872))
* **stacks:** add the dart and flutter pack ([4848a15](https://github.com/vannt-dev/repokeeper/commit/4848a150d8adf8e2571d1713b406834ffcd59bc0))
* **stacks:** add the dotnet pack ([5c138a4](https://github.com/vannt-dev/repokeeper/commit/5c138a435491bb2a0161987ea00c6c44717f32d6))
* **stacks:** add the java pack for Maven and Gradle projects ([1e950a8](https://github.com/vannt-dev/repokeeper/commit/1e950a8f9afd0c015da2b7900af45a66c0a4eacf))
* **stacks:** add the output model, git helpers and the node stack pack ([3863101](https://github.com/vannt-dev/repokeeper/commit/3863101658b0c0eb0a3512e441b3665fe95e2b9c))
* **stacks:** add the python pack with a ruff, mypy and pytest workflow ([3ef2660](https://github.com/vannt-dev/repokeeper/commit/3ef266048c133801c088b8c15dfd34a13d934852))
* **stacks:** add the script pack for shell and PowerShell repositories ([3741566](https://github.com/vannt-dev/repokeeper/commit/3741566df8dccc6d88f1c969a8c6275418908c2a))
* **stacks:** prepare hooks, release and detection for stacks without node ([5f4c284](https://github.com/vannt-dev/repokeeper/commit/5f4c2843b7998a7fb431c20ddd665335639a72ab))
* **stacks:** report CI inputs and the release type from the node pack ([5817eff](https://github.com/vannt-dev/repokeeper/commit/5817effe2a93045c744961408d90ca3f5e5d4002))
* **stacks:** run NestJS end-to-end tests in CI ([267a8d1](https://github.com/vannt-dev/repokeeper/commit/267a8d1a9b3fbab791922ce5a390745fc1cd3ab5))
* **sync:** add hashing, marked blocks and JSON key editing ([5b230d3](https://github.com/vannt-dev/repokeeper/commit/5b230d3bf1a7cbe4aa573df8a7d9d72112a78642))
* **sync:** add seed outputs that are created once and then left to other tools ([f509aa4](https://github.com/vannt-dev/repokeeper/commit/f509aa490703f60a6a8e8c00a881aaa80149fc69))
* **sync:** add the lock file and the per-output decision table ([20bb884](https://github.com/vannt-dev/repokeeper/commit/20bb8846c6bbee79c24166af238c3c021ec96f03))
* **sync:** compute and apply a sync without overwriting local edits ([2c4180d](https://github.com/vannt-dev/repokeeper/commit/2c4180de6d99fb7bc7a89a77a09e09e346741136))
* **sync:** manage named keys of YAML files so users can add their own jobs ([cd97fb3](https://github.com/vannt-dev/repokeeper/commit/cd97fb37abbee6493c99c92d823c2dcd7ecf8982))
* **workflows:** add reusable node, commitlint and release workflows with fixtures ([a63f82e](https://github.com/vannt-dev/repokeeper/commit/a63f82edb75928a7adb6d002e4575206a3b703a0))


### Bug Fixes

* **cli:** check for uncommitted files before printing the plan and label untracked ones ([168525f](https://github.com/vannt-dev/repokeeper/commit/168525fdd4986d2d44212564ea4e591a892f3702))
* **fixtures:** give the Java fixtures their real GreeterTest ([787ed9a](https://github.com/vannt-dev/repokeeper/commit/787ed9ae6ec344a746835eb63fd5363b18015f22))
* **workflows:** name the reusable release workflow release-please.yml and match pull_request: ([d06297a](https://github.com/vannt-dev/repokeeper/commit/d06297a3132e1b7c053ba07e55bd351d0fef28e7))
