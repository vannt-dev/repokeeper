# Gradle version markers — Design

Status: approved (design), pending implementation plan

## Problem

For Gradle projects (the `kotlin` stack, and `java` without a pom), repokeeper
emits a `simple` release with `extra-files: ["gradle.properties"]`.
release-please's generic updater only rewrites a version inside
`x-release-please` markers, and nothing adds them. So releases are tagged
(repokeeper-demo-kotlin is at `v1.0.0`) while `gradle.properties` keeps
`version=0.0.0`.

In a `.properties` file `#` starts a comment only at the start of a line, so
the inline form (`version=1.0.0 # x-release-please-version`) would become
part of the value. The block form is required:

```properties
# x-release-please-start-version
version=1.0.0
# x-release-please-end
```

## Decision

repokeeper adds the block markers around the `version=` line once, and
leaves the file to release-please after that. The version itself is never
compared or written by repokeeper, so a release bumping it is not drift.

## Output kind `marker`

```ts
/** release-please version markers around one line of a file the user owns. */
export interface MarkerOutput {
  kind: "marker";
  path: string;   // "gradle.properties"
  line: string;   // regex source of the line to wrap: "^version\\s*="
  module: string;
}
```

- `outputId`: `marker:<path>`. `describeOutput`: `<path> (release-please version markers)`.
- Lock target: `{ kind: "marker", path, line }`.
- **State.** `desiredText` is `""`. `readCurrent` returns `""` when there is
  nothing to do: the file is missing, it has no line matching `line`, or it
  already contains `x-release-please-start-version` or
  `x-release-please-version` anywhere. The last case means markers the user
  placed themselves are respected. Otherwise it returns `"unmarked"`.
- **Decision.** Equal to desired → `unchanged`; otherwise always `write`.
  Adding two comment lines is always safe, so a marker is never `conflict`
  or `unmanaged`.
- **Write.** It inserts `# x-release-please-start-version` directly above,
  and `# x-release-please-end` directly below, the first matching line. It
  keeps the file's line ending (CRLF or LF) and every other byte, and never
  creates a file.
- **Removal** (the standard stops producing it): `left`. The markers stay,
  as a seed does, because release-please uses them.
- The usual guard against uncommitted edits applies, since the path is
  written.

## Gradle stack and release module

- `ReleaseInfo` gains `versionLine?: { path: string; line: string }`.
- `gradleBuild` sets `extraFiles: ["gradle.properties"]` and
  `versionLine: { path: "gradle.properties", line: "^version\\s*=" }` only
  when `gradle.properties` has a `version=` line. Previously the file was
  listed even without a version, where release-please could do nothing.
- The release module emits one `MarkerOutput` (module `release`) when the
  picked release has a `versionLine`.
- A stale version (`version=0.0.0` after `v1.0.0`) is not corrected by
  repokeeper. release-please writes the next version inside the markers on
  the next release.

## Testing

- `test/sync-marker.test.ts`: create markers (LF and CRLF, other lines
  untouched); `unchanged` when markers exist, including user-placed inline
  ones; `unchanged` when the file or the line is missing, with no file
  created; a version bumped inside the markers stays `unchanged`; removal is
  `left` and keeps the markers; `hasDrift` before and after.
- Stack tests (java, kotlin): `versionLine` present with a version line; no
  `extraFiles` and no `versionLine` without one.
- Release module: emits the marker output only when `versionLine` is set.
- e2e: `init` on a Gradle repository wraps `version=` in markers, and `check`
  then reports no drift.

## Rollout

Standard 1.4.3, repokeeper 0.4.7. Then update repokeeper-demo-kotlin (the
only Gradle repository among the managed ones) and confirm the markers.
