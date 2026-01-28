/** Target formats for getting diffs */
export type DiffTarget =
  | "staged"
  | "HEAD"
  | `branch:${string}`
  | `commit:${string}`
  | `range:${string}..${string}`;

/** Result of a diff operation */
export interface DiffResult {
  /** The raw unified diff string */
  diff: string;
  /** The target that was used */
  target: string;
  /** Whether there were any changes */
  hasChanges: boolean;
}

/** Errors specific to git operations */
export class GitError extends Error {
  constructor(
    message: string,
    public readonly code: GitErrorCode
  ) {
    super(message);
    this.name = "GitError";
  }
}

export type GitErrorCode =
  | "NOT_A_REPO"
  | "NO_CHANGES"
  | "INVALID_TARGET"
  | "BRANCH_NOT_FOUND"
  | "COMMIT_NOT_FOUND"
  | "GIT_ERROR";
