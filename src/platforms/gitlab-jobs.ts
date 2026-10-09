import type { ResolvedStack } from "../model.js";

export const NOT_SCHEDULED = '$CI_PIPELINE_SOURCE != "schedule"';
/**
 * True unless the pipeline is for the commit the release job pushed. That commit carries no
 * `[skip ci]`: GitLab would skip the pipeline of the release's tag with it, and the tag pipeline is
 * where a project's own publishing jobs run. The managed jobs stay away from the commit by this rule
 * instead. A merge request has no `CI_COMMIT_BRANCH`, so a commit named like a release is still checked there.
 */
export const NOT_THE_RELEASE_COMMIT = "($CI_COMMIT_BRANCH == null || $CI_COMMIT_MESSAGE !~ /^chore\\(release\\): /)";
/** The checks of a change: merge requests and the default branch, not schedules, tag pipelines or the release commit. */
export const FOR_CHANGES = `${NOT_SCHEDULED} && $CI_COMMIT_TAG == null && ${NOT_THE_RELEASE_COMMIT}`;

type Job = Record<string, unknown>;
type Input = Record<string, string>;

const list = (input: Input, key: string): string[] => JSON.parse(input[key] ?? "[]") as string[];

/** A job per version: the image is named with the matrix variable, so each run pulls its own. */
function perVersion(image: string, variable: string, versions: string[], script: string[], more: Job = {}): Job {
  return {
    stage: "test",
    image,
    parallel: { matrix: [{ [variable]: versions }] },
    rules: [{ if: FOR_CHANGES }],
    ...more,
    script,
  };
}

/** A job that runs once. */
const once = (image: string, script: string[], more: Job = {}): Job => ({
  stage: "test",
  image,
  rules: [{ if: FOR_CHANGES }],
  ...more,
  script,
});

/** The version of shfmt the script stack checks with; the same as in .github/workflows/stack-script.yml. */
export const SHFMT_VERSION = "3.14.1";
/** The version of PSScriptAnalyzer the script stack checks with; the same as in stack-script.yml. */
export const SCRIPT_ANALYZER_VERSION = "1.25.0";

const SHFMT = `wget -q -O /usr/local/bin/shfmt https://github.com/mvdan/sh/releases/download/v${SHFMT_VERSION}/shfmt_v${SHFMT_VERSION}_linux_amd64
chmod +x /usr/local/bin/shfmt
git ls-files -z '*.sh' | xargs -0 -r shfmt -d
`;

// the settings file is the repository's own choice of rules; without one, errors and warnings fail the job.
// Stop on the first error: an analyzer that fails to load would otherwise report no issues and pass
const SCRIPT_ANALYZER = `pwsh -NoProfile -Command '
$ErrorActionPreference = "Stop"
Set-PSRepository PSGallery -InstallationPolicy Trusted
Install-Module PSScriptAnalyzer -RequiredVersion ${SCRIPT_ANALYZER_VERSION} -Force -Scope CurrentUser
$issues = if (Test-Path PSScriptAnalyzerSettings.psd1) {
  Invoke-ScriptAnalyzer -Path . -Recurse -Settings PSScriptAnalyzerSettings.psd1
} else {
  Invoke-ScriptAnalyzer -Path . -Recurse -Severity Error, Warning
}
$issues | Format-Table -AutoSize
if ($issues) { exit 1 }
'
`;

/** Composer is not in the php image; neither are the git and unzip it fetches packages with. */
const COMPOSER = `apt-get update -qq && apt-get install -y -qq git unzip > /dev/null
php -r "copy('https://getcomposer.org/installer', '/tmp/composer-setup.php');"
php /tmp/composer-setup.php --quiet --install-dir=/usr/local/bin --filename=composer
`;

/**
 * PowerShell for Linux. Not `mcr.microsoft.com/powershell`: its `latest` stopped at 7.4.2, older than
 * PSScriptAnalyzer loads on. The .NET SDK image carries a PowerShell that is kept current.
 */
const POWERSHELL_IMAGE = "mcr.microsoft.com/dotnet/sdk:10.0";

/** Newest first, so the image is the newest SDK and the older ones are installed beside it. */
const newestFirst = (versions: string[]) =>
  [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

/**
 * The CI jobs of a stack on GitLab: the inputs its GitHub reusable workflow receives, run in a
 * container image instead of on a runner that a setup action prepares. node and go are in gitlab.ts.
 */
export function stackJobs(stack: ResolvedStack): Array<{ key: string; job: Job }> {
  const input = stack.ci?.with;
  if (input === undefined) return [];
  const commands = list(input, "commands");
  const install = input["install-command"] ? [input["install-command"]] : [];

  if (stack.id === "python") {
    const uv = input.manager === "uv";
    return [
      {
        key: "python",
        job: perVersion(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
          "python:${PYTHON_VERSION}",
          "PYTHON_VERSION",
          list(input, "python-versions"),
          [...(uv ? ["python -m pip install uv"] : []), ...install, ...commands],
          // uv then runs the image's interpreter instead of fetching one of its own choice
          { variables: { PIP_ROOT_USER_ACTION: "ignore", ...(uv ? { UV_PYTHON: "$PYTHON_VERSION" } : {}) } },
        ),
      },
    ];
  }
  if (stack.id === "rust") {
    return [
      {
        key: "rust",
        // the toolchain is installed by name, as on GitHub, so "stable", "beta" and "1.80" all work
        job: perVersion("rust:latest", "RUST_VERSION", list(input, "rust-versions"), [
          'rustup toolchain install "$RUST_VERSION" --profile minimal --component rustfmt,clippy',
          'rustup default "$RUST_VERSION"',
          ...commands,
        ]),
      },
    ];
  }
  if (stack.id === "ruby") {
    return [
      {
        key: "ruby",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
        job: perVersion("ruby:${RUBY_VERSION}", "RUBY_VERSION", list(input, "ruby-versions"), [
          ...install,
          ...commands,
        ]),
      },
    ];
  }
  if (stack.id === "php") {
    return [
      {
        key: "php",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
        job: perVersion("php:${PHP_VERSION}-cli", "PHP_VERSION", list(input, "php-versions"), [
          COMPOSER,
          ...install,
          ...commands,
        ]),
      },
    ];
  }
  if (stack.id === "dart") {
    const flutter = input.flutter === "true";
    return [
      {
        key: "dart",
        job: perVersion(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
          flutter ? "ghcr.io/cirruslabs/flutter:${SDK_VERSION}" : "dart:${SDK_VERSION}",
          "SDK_VERSION",
          list(input, "sdk-versions"),
          [...install, ...commands],
        ),
      },
    ];
  }
  if (stack.id === "java" || stack.id === "kotlin") {
    const image =
      input["build-tool"] === "maven"
        ? // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
          "maven:3-eclipse-temurin-${JAVA_VERSION}"
        : input["gradle-version"] === ""
          ? // the project's own wrapper fetches its Gradle
            // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
            "eclipse-temurin:${JAVA_VERSION}-jdk"
          : // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitLab CI variable
            "gradle:jdk${JAVA_VERSION}";
    return [{ key: stack.id, job: perVersion(image, "JAVA_VERSION", list(input, "java-versions"), commands) }];
  }
  if (stack.id === "dotnet") {
    const [newest = "9.0", ...older] = newestFirst(list(input, "dotnet-versions"));
    return [
      {
        key: "dotnet",
        // one job with every SDK side by side, as on GitHub: a project may target several of them
        job: once(
          `mcr.microsoft.com/dotnet/sdk:${newest}`,
          [
            ...older.map(
              (version) =>
                `curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel ${version} --install-dir /usr/share/dotnet`,
            ),
            ...commands,
          ],
          { variables: { DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" } },
        ),
      },
    ];
  }
  if (stack.id === "script") {
    const jobs: Array<{ key: string; job: Job }> = [];
    if (input["shell-scripts"] === "true") {
      jobs.push({
        key: "shell",
        job: once("koalaman/shellcheck-alpine:stable", [
          "apk add --no-cache git > /dev/null",
          "git ls-files -z '*.sh' | xargs -0 -r shellcheck",
          SHFMT,
        ]),
      });
    }
    if (input["powershell-scripts"] === "true") {
      jobs.push({ key: "powershell", job: once(POWERSHELL_IMAGE, [SCRIPT_ANALYZER]) });
    }
    // the image has both bash and pwsh, whichever the test command is written for
    if (input["test-command"]) jobs.push({ key: "script-test", job: once(POWERSHELL_IMAGE, [input["test-command"]]) });
    return jobs;
  }
  return [];
}

/** Every key `stackJobs` can write, in the order they appear in .gitlab-ci.yml. */
export const STACK_JOB_KEYS = [
  "python",
  "dart",
  "shell",
  "powershell",
  "script-test",
  "java",
  "dotnet",
  "rust",
  "kotlin",
  "php",
  "ruby",
] as const;
