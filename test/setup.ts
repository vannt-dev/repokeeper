// A test that runs git in a scratch directory has to reach the repository of that directory. Started from
// a git hook in a linked worktree (the pre-push hook runs this suite), git exports where *this* repository
// is, and every `git init` of a test then writes into it instead: 72 tests fail on a push that would pass
// from the main checkout.
for (const name of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
]) {
  delete process.env[name];
}
