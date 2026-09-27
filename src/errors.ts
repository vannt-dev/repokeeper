export class RepokeeperError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** `.repokeeper.yml` is missing or invalid. */
export class ConfigError extends RepokeeperError {
  constructor(message: string) {
    super(message, 2);
  }
}

/** The command cannot run as requested. */
export class UsageError extends RepokeeperError {
  constructor(message: string) {
    super(message, 2);
  }
}

/** A GitHub API call failed; nothing on disk was touched. */
export class ApiError extends RepokeeperError {
  constructor(message: string) {
    super(message, 3);
  }
}

/** `.repokeeper/lock.json` is unreadable; the repository state is unknown, which counts as drift. */
export class LockError extends RepokeeperError {
  constructor(message: string) {
    super(message, 1);
  }
}
