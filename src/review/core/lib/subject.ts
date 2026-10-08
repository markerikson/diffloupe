/**
 * A checkout of the commit under review, kept separate from the checkout the
 * reviewer is running out of.
 *
 * Every stage that inspects source — the registry check, the repo map, the
 * agent's own file reads, the line-number verification — reads the working tree,
 * so the working tree has to be at the PR head. Moving the launching checkout to
 * get there is wrong twice over: it discards a developer's branch position, and
 * it swaps the reviewer's own scripts for the PR's version of them mid-run.
 *
 * A detached git worktree shares the object store, so this costs a file
 * materialization rather than a clone.
 */
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, text } from "./proc.ts";

/**
 * Path identity as the filesystem sees it rather than as the string reads.
 *
 * Every question this module asks about a directory — is it the root of its own
 * working tree, is it the clone we are running from — is a question about which
 * directory it *is*, and two different strings routinely name one directory.
 * `git rev-parse --show-toplevel` reports a physical path with every symlinked
 * component resolved; `path.resolve` folds `.` and `..` and stops there. On
 * macOS `os.tmpdir()` sits under `/var`, which is a link to `/private/var`, so
 * the default subject directory takes that difference on every run.
 *
 * A path that does not exist yet is not the same file as anything, and cannot be
 * resolved, so it falls back to lexical normalisation.
 */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function samePath(a: string, b: string): boolean {
  return realPath(a) === realPath(b);
}

export interface Subject {
  /** Working tree at the commit under review. */
  dir: string;
  /** Removes the worktree, unless the caller supplied the directory. */
  release: () => Promise<void>;
}

async function removeWorktree(home: string, dir: string): Promise<void> {
  await run("git", ["-C", home, "worktree", "remove", "--force", dir], { allowFail: true });
  await run("git", ["-C", home, "worktree", "prune"], { allowFail: true });
}

/**
 * A PR head commit is often absent from a local clone — it lives on a fork or on
 * a branch that was deleted after merge. GitHub keeps it reachable as
 * `refs/pull/<n>/head`, which is fetchable from the base repo.
 */
async function ensureCommit(
  home: string,
  pr: string | number | undefined,
  head: string,
): Promise<void> {
  const have = await run("git", ["-C", home, "cat-file", "-e", `${head}^{commit}`], { allowFail: true });
  if (have.code === 0) return;
  // Reviewing a bare commit range: there is no pull request ref to fall back on,
  // so a commit this clone does not have is simply unreachable.
  if (pr === undefined) {
    throw new Error(`commit ${head} is not in this clone`);
  }
  await run("git", ["-C", home, "fetch", "-q", "origin", `refs/pull/${pr}/head`], { allowFail: true });
  const again = await run("git", ["-C", home, "cat-file", "-e", `${head}^{commit}`], { allowFail: true });
  if (again.code !== 0) {
    throw new Error(
      `commit ${head} is not in this clone and could not be fetched from refs/pull/${pr}/head`,
    );
  }
}

export async function openSubject(
  home: string,
  pr: string | number | undefined,
  head: string,
): Promise<Subject> {
  // In CI the workflow has already checked out the head commit.
  if (process.env.CODE_REVIEW_NO_CHECKOUT === "1") {
    return { dir: home, release: async () => {} };
  }
  const explicit = process.env.CODE_REVIEW_SUBJECT_DIR;
  if (!explicit) {
    // One directory per run. Two reviews of the same head commit run side by
    // side (a re-run, or an eval sweep next to a manual run), and the first one
    // to finish removes the worktree while the other is still reading it.
    const dir = path.join(
      os.tmpdir(),
      `code-review-subject-${head.slice(0, 12)}-${process.pid}-${randomBytes(3).toString("hex")}`,
    );
    await ensureCommit(home, pr, head);
    await text("git", ["-C", home, "worktree", "add", "--detach", "-q", dir, head]);
    return { dir, release: () => removeWorktree(home, dir) };
  }
  const dir = explicit;
  // An explicitly named directory is the caller's: repeat runs reuse it rather
  // than materializing 10k files again.
  const release = async () => {};

  // `rev-parse` answers for the enclosing repository, not for `dir` itself, so
  // it succeeds for any plain folder that happens to sit inside a checkout —
  // including one under the reviewer's own clone. Acting on that answer would
  // detach their repository onto the pull request head, discarding their branch
  // position and swapping the scripts out from under the running review. Only a
  // directory that is the root of its own working tree is ours to move.
  const top = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"], { allowFail: true });
  const isOwnTree = top.code === 0 && samePath(top.stdout.trim(), dir);
  const at = isOwnTree
    ? await run("git", ["-C", dir, "rev-parse", "HEAD"], { allowFail: true })
    : { code: 1, stdout: "", stderr: "" };
  if (at.code === 0 && at.stdout.trim().startsWith(head)) return { dir, release };

  await ensureCommit(home, pr, head);

  // A stale worktree at the wrong commit is worse than none: the registry check
  // and the line verification would silently read the wrong source. But a
  // directory the caller named is the caller's, and `worktree remove --force`
  // discards uncommitted work in it. Move it to the right commit instead,
  // refusing a dirty tree first — git will not: `checkout --detach` only aborts
  // when a modified file would be overwritten, and an edit to a file the two
  // commits agree on is carried into the new tree untouched, where the review
  // reads it as if it were the pull request head.
  if (at.code === 0) {
    // Tracked files only: an untracked file is the caller's and survives the
    // move untouched — the hazard is an *edit* to a tracked file, which the
    // checkout carries forward silently whenever the two commits agree on that
    // file, leaving content in the tree that is not the head commit.
    const dirty = await run("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"], {
      allowFail: true,
    });
    if (dirty.code !== 0 || dirty.stdout.trim() !== "") {
      throw new Error(
        `CODE_REVIEW_SUBJECT_DIR ${dir} has uncommitted changes to tracked files, so it was ` +
          `not moved to ${head.slice(0, 10)}. Commit, stash or discard them, or point it somewhere else.`,
      );
    }
    // The clone the review is running out of is never ours to move. It is the
    // root of its own working tree, so it passes the check above — but detaching
    // it discards the caller's branch position and swaps the reviewer's own
    // scripts for the pull request's copy of them mid-run, which is the whole
    // failure this module exists to prevent.
    if (samePath(dir, home)) {
      throw new Error(
        `CODE_REVIEW_SUBJECT_DIR ${dir} is the checkout this review is running from, ` +
          `and it is not at ${head.slice(0, 10)}. Point it somewhere else, or set ` +
          `CODE_REVIEW_NO_CHECKOUT=1 when the checkout is already at the head commit.`,
      );
    }
    const moved = await run("git", ["-C", dir, "checkout", "--detach", "-q", head], { allowFail: true });
    if (moved.code !== 0) {
      throw new Error(
        `CODE_REVIEW_SUBJECT_DIR ${dir} could not be moved to ${head.slice(0, 10)}: ` +
          `${moved.stderr.trim() || "checkout failed"}`,
      );
    }
    return { dir, release };
  }
  // Nothing there yet is fine — that is the first run of a reused directory.
  // Something there that is not the root of its own working tree is not:
  // adding a worktree would fail on a non-empty directory, and removing it,
  // or checking out over the repository that contains it, is not ours to do.
  if (existsSync(dir)) {
    throw new Error(
      `CODE_REVIEW_SUBJECT_DIR ${dir} exists but is not the root of its own git working tree` +
        (top.code === 0 ? ` — it sits inside ${top.stdout.trim()}` : ""),
    );
  }
  await text("git", ["-C", home, "worktree", "add", "--detach", "-q", dir, head]);
  return { dir, release };
}
