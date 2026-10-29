# Changelog

## [0.16.0](https://github.com/vannt-dev/repokeeper/compare/v0.15.0...v0.16.0) (2026-10-29)


### Features

* write the LICENSE for more licenses than MIT ([#92](https://github.com/vannt-dev/repokeeper/issues/92)) ([21269ef](https://github.com/vannt-dev/repokeeper/commit/21269eff8206e633ba778cf4f2a04272395781fa))

## [0.15.0](https://github.com/vannt-dev/repokeeper/compare/v0.14.0...v0.15.0) (2026-10-28)


### Features

* **github:** show each repository's standard in github status ([#90](https://github.com/vannt-dev/repokeeper/issues/90)) ([f8d43a2](https://github.com/vannt-dev/repokeeper/commit/f8d43a2e6b33140382d004b16b871dd03a836eba))

## [0.14.0](https://github.com/vannt-dev/repokeeper/compare/v0.13.1...v0.14.0) (2026-10-26)


### Features

* name the new files a Biome or Prettier setup should leave alone ([#88](https://github.com/vannt-dev/repokeeper/issues/88)) ([359978f](https://github.com/vannt-dev/repokeeper/commit/359978f4a59f87bbf525a2057ee59869a32fcf85))

## [0.13.1](https://github.com/vannt-dev/repokeeper/compare/v0.13.0...v0.13.1) (2026-10-26)


### Bug Fixes

* **deps:** update fast-uri to 3.1.9 ([#86](https://github.com/vannt-dev/repokeeper/issues/86)) ([f469106](https://github.com/vannt-dev/repokeeper/commit/f46910694cd1d8b5a1b478f34c15168860e679cf))

## [0.13.0](https://github.com/vannt-dev/repokeeper/compare/v0.12.0...v0.13.0) (2026-10-22)


### Features

* add github status, a report across an owner's repositories ([#82](https://github.com/vannt-dev/repokeeper/issues/82)) ([8303c04](https://github.com/vannt-dev/repokeeper/commit/8303c043e91f93ff643e9db6ecc7b8e75703196b))

## [0.12.0](https://github.com/vannt-dev/repokeeper/compare/v0.11.0...v0.12.0) (2026-10-21)


### Features

* **dotnet:** test on the .NET 10 SDK by default ([#79](https://github.com/vannt-dev/repokeeper/issues/79)) ([156030c](https://github.com/vannt-dev/repokeeper/commit/156030cbaca864d5f5d4f8ac7ca79472757f593d))

## [0.11.0](https://github.com/vannt-dev/repokeeper/compare/v0.10.0...v0.11.0) (2026-10-20)


### Features

* a newer version of an action a managed step uses is not drift ([3987e52](https://github.com/vannt-dev/repokeeper/commit/3987e52ce8afe11c15cfdd463d55628c049907b3))
* auto-merge Dependabot's patch and minor updates, when asked ([43719d3](https://github.com/vannt-dev/repokeeper/commit/43719d3415de0151cc30ee526b2d1ba0e2f6df22))
* auto-merge Dependabot's patch and minor updates, when asked ([52c1a35](https://github.com/vannt-dev/repokeeper/commit/52c1a354a6476432bab87833dbfdd2e8881725cc))
* delete Actions caches nothing will read again, when asked ([5a19c3f](https://github.com/vannt-dev/repokeeper/commit/5a19c3f1b517343baf14abae40b81687e7ce354c))
* delete Actions caches nothing will read again, when asked ([cada235](https://github.com/vannt-dev/repokeeper/commit/cada235ef2dceff2eafdb530d940a5498c946bd7))
* publish releases to npm and PyPI through trusted publishing, when asked ([a50597c](https://github.com/vannt-dev/repokeeper/commit/a50597c828b2cef95271c215d55d5fc9cbd1bf4c))
* publish releases to npm and PyPI through trusted publishing, when asked ([768e626](https://github.com/vannt-dev/repokeeper/commit/768e6262c4f84c5fc6c2ed3d84e9f5d33c58fbc6))

## [0.10.0](https://github.com/vannt-dev/repokeeper/compare/v0.9.0...v0.10.0) (2026-10-17)


### Features

* skip the stack jobs of docs-only pull requests, when asked ([#70](https://github.com/vannt-dev/repokeeper/issues/70)) ([72ed441](https://github.com/vannt-dev/repokeeper/commit/72ed4418d106239832afbf3ae6ea38d7c806e524))

## [0.9.0](https://github.com/vannt-dev/repokeeper/compare/v0.8.2...v0.9.0) (2026-10-13)


### Features

* a docker stack that lints Dockerfiles with hadolint ([#66](https://github.com/vannt-dev/repokeeper/issues/66)) ([de665b1](https://github.com/vannt-dev/repokeeper/commit/de665b1c32afe0877cf9e248f2c597cbaeca406a))
* code scanning with CodeQL, and secret scanning as a setting ([#65](https://github.com/vannt-dev/repokeeper/issues/65)) ([bea1579](https://github.com/vannt-dev/repokeeper/commit/bea15793b45b74c6a4f725316e228fea702db359))
* open a pull request when the standard has moved ([#62](https://github.com/vannt-dev/repokeeper/issues/62)) ([434c5bd](https://github.com/vannt-dev/repokeeper/commit/434c5bdc7c016da850aa1e3f4e8c5b814b560ce5))


### Bug Fixes

* ship the update workflow in the package ([#64](https://github.com/vannt-dev/repokeeper/issues/64)) ([47d4e27](https://github.com/vannt-dev/repokeeper/commit/47d4e2712ff349460dd215f35858677f6adba4d6))

## [0.8.2](https://github.com/vannt-dev/repokeeper/compare/v0.8.1...v0.8.2) (2026-10-10)


### Bug Fixes

* **standard:** move lefthook to 2.2.1 and Renovate to 44.149.2 ([#60](https://github.com/vannt-dev/repokeeper/issues/60)) ([211b88d](https://github.com/vannt-dev/repokeeper/commit/211b88dee580df709f07b3ede28e965a3a4adff5))

## [0.8.1](https://github.com/vannt-dev/repokeeper/compare/v0.8.0...v0.8.1) (2026-10-10)


### Bug Fixes

* **gitlab:** keep Renovate off the images of the managed jobs ([#58](https://github.com/vannt-dev/repokeeper/issues/58)) ([f70632e](https://github.com/vannt-dev/repokeeper/commit/f70632e3a4b8430d9cab2b1b13bfdcf898deceb6))

## [0.8.0](https://github.com/vannt-dev/repokeeper/compare/v0.7.0...v0.8.0) (2026-10-10)


### Features

* **gitlab:** make the strict preset protect the default branch on GitLab ([#54](https://github.com/vannt-dev/repokeeper/issues/54)) ([ac12a80](https://github.com/vannt-dev/repokeeper/commit/ac12a80de35c1b59c397cd598604b03acab870df))


### Bug Fixes

* **gitlab:** let the pipeline of a release's tag run ([#53](https://github.com/vannt-dev/repokeeper/issues/53)) ([b5fa09e](https://github.com/vannt-dev/repokeeper/commit/b5fa09ee82266463d732e273c585a1d9896574b4))

## [0.7.0](https://github.com/vannt-dev/repokeeper/compare/v0.6.0...v0.7.0) (2026-10-09)


### Features

* add repokeeper bump to write a release's version into the stack's files ([#50](https://github.com/vannt-dev/repokeeper/issues/50)) ([639cd80](https://github.com/vannt-dev/repokeeper/commit/639cd801f6ed41c13c361bc173eb6d9378a2e9e5))
* **gitlab:** support every stack on GitLab ([#51](https://github.com/vannt-dev/repokeeper/issues/51)) ([d1d3b33](https://github.com/vannt-dev/repokeeper/commit/d1d3b33c6f351bdc05d15848ffe85915d9bfe7ac))

## [0.6.0](https://github.com/vannt-dev/repokeeper/compare/v0.5.0...v0.6.0) (2026-10-09)


### Features

* **gitlab:** add repokeeper gitlab apply for project settings and branch protection ([#48](https://github.com/vannt-dev/repokeeper/issues/48)) ([490d80b](https://github.com/vannt-dev/repokeeper/commit/490d80bfb6e135c3eba8f55bf9e86cf5ad335ca9))
* **gitlab:** support the go stack on GitLab ([#49](https://github.com/vannt-dev/repokeeper/issues/49)) ([3e07b84](https://github.com/vannt-dev/repokeeper/commit/3e07b843d54cf9737403185bb74e99d4f202abae))
* **init:** apply a .repokeeper.yml that was written before the first run ([#46](https://github.com/vannt-dev/repokeeper/issues/46)) ([03e6ef8](https://github.com/vannt-dev/repokeeper/commit/03e6ef8fbee64a5535e2c92659eb3fab0b01800c))
* manage stacks that live in folders of a monorepo ([#41](https://github.com/vannt-dev/repokeeper/issues/41)) ([ab88e60](https://github.com/vannt-dev/repokeeper/commit/ab88e60a6e22bb00ce2e07299af9d259e1a954e9))
* pin the reusable workflows, call a mirror, or keep local copies with eject ([#43](https://github.com/vannt-dev/repokeeper/issues/43)) ([c5a725a](https://github.com/vannt-dev/repokeeper/commit/c5a725a09274235132cc68efbc75c704808f5119))
* presets and an interactive mode for init ([#44](https://github.com/vannt-dev/repokeeper/issues/44)) ([1aa9811](https://github.com/vannt-dev/repokeeper/commit/1aa9811d0f323a463af9164324d97ca674a8a362))

## [0.5.0](https://github.com/vannt-dev/repokeeper/compare/v0.4.7...v0.5.0) (2026-10-01)


### Features

* add a GitLab platform adapter for the node stack ([#36](https://github.com/vannt-dev/repokeeper/issues/36)) ([4f389f0](https://github.com/vannt-dev/repokeeper/commit/4f389f017630a7034838b598ee899040687995c9))

## [0.4.7](https://github.com/vannt-dev/repokeeper/compare/v0.4.6...v0.4.7) (2026-10-01)


### Bug Fixes

* **release:** add release-please markers around the gradle.properties version ([#34](https://github.com/vannt-dev/repokeeper/issues/34)) ([c862008](https://github.com/vannt-dev/repokeeper/commit/c862008446fa2f27e7755e5dc9f29e4ce785ec38))

## [0.4.6](https://github.com/vannt-dev/repokeeper/compare/v0.4.5...v0.4.6) (2026-09-29)


### Bug Fixes

* **release:** hide chore commits for php releases ([#32](https://github.com/vannt-dev/repokeeper/issues/32)) ([637a601](https://github.com/vannt-dev/repokeeper/commit/637a60107cc680bbf010fa32a1d9e0a200237122))

## [0.4.5](https://github.com/vannt-dev/repokeeper/compare/v0.4.4...v0.4.5) (2026-09-28)


### Bug Fixes

* **release:** set initial-version only before the first release tag ([#30](https://github.com/vannt-dev/repokeeper/issues/30)) ([3819874](https://github.com/vannt-dev/repokeeper/commit/38198746197e42bfb76d0ef125f5730d213a30e8))

## [0.4.4](https://github.com/vannt-dev/repokeeper/compare/v0.4.3...v0.4.4) (2026-09-28)


### Bug Fixes

* **release:** approve the held CI runs of release pull requests instead of dispatching CI ([#29](https://github.com/vannt-dev/repokeeper/issues/29)) ([1c87d86](https://github.com/vannt-dev/repokeeper/commit/1c87d86ced21f4d9d84a16839717a59f363eda71))
* **release:** run CI on release pull requests and start new repositories at 0.1.0 ([#27](https://github.com/vannt-dev/repokeeper/issues/27)) ([09eb47e](https://github.com/vannt-dev/repokeeper/commit/09eb47e46d1de64d890399bf460642d74ef368f3))

## [0.4.3](https://github.com/vannt-dev/repokeeper/compare/v0.4.2...v0.4.3) (2026-09-28)


### Bug Fixes

* **release:** skip the SNAPSHOT pull request for maven ([#25](https://github.com/vannt-dev/repokeeper/issues/25)) ([2bc0075](https://github.com/vannt-dev/repokeeper/commit/2bc0075c5162c702db103a48a8c5ec05193b813a))

## [0.4.2](https://github.com/vannt-dev/repokeeper/compare/v0.4.1...v0.4.2) (2026-09-28)


### Bug Fixes

* **commitlint:** skip Dependabot commits in the reusable workflow ([#23](https://github.com/vannt-dev/repokeeper/issues/23)) ([272c067](https://github.com/vannt-dev/repokeeper/commit/272c067c7701ef9866f8e6f506b25b5e6f6b498e))

## [0.4.1](https://github.com/vannt-dev/repokeeper/compare/v0.4.0...v0.4.1) (2026-09-28)


### Bug Fixes

* **deps:** give Dependabot commits a chore(deps) prefix ([#21](https://github.com/vannt-dev/repokeeper/issues/21)) ([cc8e973](https://github.com/vannt-dev/repokeeper/commit/cc8e973662b76e3793b3f684171ddc963c187829))

## [0.4.0](https://github.com/vannt-dev/repokeeper/compare/v0.3.0...v0.4.0) (2026-09-27)


### Features

* go, rust, kotlin, php and ruby stack packs ([#17](https://github.com/vannt-dev/repokeeper/issues/17)) ([0f9d541](https://github.com/vannt-dev/repokeeper/commit/0f9d5410960005a1394099a95b0a0eb0d150c758))

## [0.3.0](https://github.com/vannt-dev/repokeeper/compare/v0.2.3...v0.3.0) (2026-09-27)


### Features

* github apply and an opt-in drift check ([#14](https://github.com/vannt-dev/repokeeper/issues/14)) ([3947d31](https://github.com/vannt-dev/repokeeper/commit/3947d312eea1b75756314b27f0832e56a36b5bfb))

## [0.2.3](https://github.com/vannt-dev/repokeeper/compare/v0.2.2...v0.2.3) (2026-09-27)


### Bug Fixes

* findings from the python, dart, powershell, java and .NET pilots ([#12](https://github.com/vannt-dev/repokeeper/issues/12)) ([14777a4](https://github.com/vannt-dev/repokeeper/commit/14777a4390a07a38f8ca07ce4b1cf0b71fd9b651))

## [0.2.2](https://github.com/vannt-dev/repokeeper/compare/v0.2.1...v0.2.2) (2026-09-27)


### Bug Fixes

* pilot findings from 0.2.1 ([#10](https://github.com/vannt-dev/repokeeper/issues/10)) ([b72553e](https://github.com/vannt-dev/repokeeper/commit/b72553ec0af6d4624b398d3cf6b28abeb0b20a09))

## [0.2.1](https://github.com/vannt-dev/repokeeper/compare/v0.2.0...v0.2.1) (2026-09-27)


### Bug Fixes

* **test:** read the expected version from package.json so release bumps don't break publish ([#7](https://github.com/vannt-dev/repokeeper/issues/7)) ([3c62cdf](https://github.com/vannt-dev/repokeeper/commit/3c62cdf1c354723cf538117dad14a2593487db39))

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
