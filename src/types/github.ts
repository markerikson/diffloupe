/**
 * GitHub Types - Type definitions for GitHub PR data
 *
 * These types match the output from `gh pr view --json` commands.
 */

/** Author information from GitHub */
export interface GitHubAuthor {
  login: string;
  name?: string;
}

/** Commit information from GitHub PR */
export interface GitHubCommit {
  messageHeadline: string;
  messageBody: string;
  oid: string;
}

/** PR metadata from `gh pr view --json` */
export interface PRMetadata {
  title: string;
  body: string;
  author: GitHubAuthor;
  commits: GitHubCommit[];
  baseRefName: string;
  headRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  number: number;
  url: string;
}

/** Errors specific to GitHub/gh CLI operations */
export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly code: GitHubErrorCode
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export type GitHubErrorCode =
  | "GH_NOT_INSTALLED"
  | "NOT_AUTHENTICATED"
  | "PR_NOT_FOUND"
  | "REPO_NOT_FOUND"
  | "NOT_IN_REPO"
  | "GH_ERROR";
