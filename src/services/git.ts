import simpleGit, { type SimpleGit } from "simple-git";
import { GitError, type DiffResult, type DiffTarget } from "../types/git.js";

/**
 * Parse a target string into git diff arguments
 */
function parseTarget(target: string): { args: string[]; description: string } {
  // staged (default)
  if (target === "staged") {
    return { args: ["--cached"], description: "staged changes" };
  }

  // HEAD - all uncommitted changes
  if (target === "HEAD") {
    return { args: ["HEAD"], description: "all uncommitted changes" };
  }

  // branch:name - compare current to branch
  if (target.startsWith("branch:")) {
    const branch = target.slice(7);
    if (!branch) {
      throw new GitError("Branch name required", "INVALID_TARGET");
    }
    return { args: [branch], description: `changes vs ${branch}` };
  }

  // commit:hash - specific commit's changes
  if (target.startsWith("commit:")) {
    const commit = target.slice(7);
    if (!commit) {
      throw new GitError("Commit hash required", "INVALID_TARGET");
    }
    // Show what that commit introduced (diff from parent)
    return { args: [`${commit}^`, commit], description: `commit ${commit}` };
  }

  // range:abc..def - commit range
  if (target.startsWith("range:")) {
    const range = target.slice(6);
    const match = range.match(/^([^.]+)\.\.([^.]+)$/);
    if (!match || !match[1] || !match[2]) {
      throw new GitError(
        "Invalid range format. Use range:abc123..def456",
        "INVALID_TARGET"
      );
    }
    return { args: [match[1], match[2]], description: `range ${range}` };
  }

  throw new GitError(
    `Unknown target format: ${target}. Use staged, HEAD, branch:name, commit:hash, or range:a..b`,
    "INVALID_TARGET"
  );
}

/**
 * Initialize git instance and verify we're in a repo
 */
async function getGit(cwd?: string): Promise<SimpleGit> {
  const git = simpleGit(cwd);

  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new GitError("Not a git repository", "NOT_A_REPO");
  }

  return git;
}

/**
 * Get a diff for the specified target
 *
 * @param target - What to diff:
 *   - "staged" (default) - staged changes
 *   - "HEAD" - all uncommitted changes
 *   - "branch:main" - compare current to branch
 *   - "commit:abc123" - specific commit
 *   - "range:abc123..def456" - commit range
 * @param cwd - Working directory (defaults to process.cwd())
 */
export async function getDiff(
  target: DiffTarget | string = "staged",
  cwd?: string
): Promise<DiffResult> {
  const git = await getGit(cwd);
  const { args } = parseTarget(target);

  try {
    const diff = await git.diff(args);

    return {
      diff,
      target,
      hasChanges: diff.trim().length > 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Detect specific git errors
    if (message.includes("unknown revision") || message.includes("bad revision")) {
      if (target.startsWith("branch:")) {
        throw new GitError(`Branch not found: ${target.slice(7)}`, "BRANCH_NOT_FOUND");
      }
      if (target.startsWith("commit:") || target.startsWith("range:")) {
        throw new GitError(`Commit not found in: ${target}`, "COMMIT_NOT_FOUND");
      }
    }

    throw new GitError(`Git error: ${message}`, "GIT_ERROR");
  }
}

/**
 * Check if there are any staged changes
 */
export async function hasStagedChanges(cwd?: string): Promise<boolean> {
  const git = await getGit(cwd);
  const status = await git.status();
  return status.staged.length > 0;
}

/**
 * Get list of staged files
 */
export async function getStagedFiles(cwd?: string): Promise<string[]> {
  const git = await getGit(cwd);
  const status = await git.status();
  return status.staged;
}
