/**
 * GitHub Service - Wrapper for gh CLI operations
 *
 * This module provides functions to interact with GitHub PRs via the `gh` CLI.
 * Requires `gh` to be installed and authenticated.
 */

import { GitHubError, type PRMetadata } from "../types/github.js";

/**
 * Check if gh CLI is installed and authenticated.
 *
 * @throws GitHubError if gh is not installed or not authenticated
 */
export async function checkGhAvailable(): Promise<void> {
  // Check if gh is installed
  const whichProc = Bun.spawn(["which", "gh"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const whichCode = await whichProc.exited;

  if (whichCode !== 0) {
    throw new GitHubError(
      "gh CLI is not installed. Install it from https://cli.github.com/",
      "GH_NOT_INSTALLED"
    );
  }

  // Check if authenticated
  const authProc = Bun.spawn(["gh", "auth", "status"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const authCode = await authProc.exited;

  if (authCode !== 0) {
    throw new GitHubError(
      "Not authenticated with GitHub. Run `gh auth login` to authenticate.",
      "NOT_AUTHENTICATED"
    );
  }
}

/**
 * Fetch the diff for a PR.
 *
 * @param prNumber - PR number
 * @param repo - Optional repo in "owner/repo" format (uses current repo if not specified)
 * @returns The unified diff string
 * @throws GitHubError on failure
 */
export async function fetchPrDiff(
  prNumber: number,
  repo?: string
): Promise<string> {
  const args = ["pr", "diff", String(prNumber)];
  if (repo) {
    args.push("-R", repo);
  }

  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    handleGhError(stderr, prNumber, repo);
  }

  return stdout;
}

/**
 * Fetch PR metadata (title, body, commits, etc).
 *
 * @param prNumber - PR number
 * @param repo - Optional repo in "owner/repo" format
 * @returns PR metadata
 * @throws GitHubError on failure
 */
export async function fetchPrMetadata(
  prNumber: number,
  repo?: string
): Promise<PRMetadata> {
  const fields = [
    "title",
    "body",
    "author",
    "commits",
    "baseRefName",
    "headRefName",
    "state",
    "number",
    "url",
  ].join(",");

  const args = ["pr", "view", String(prNumber), "--json", fields];
  if (repo) {
    args.push("-R", repo);
  }

  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    handleGhError(stderr, prNumber, repo);
  }

  try {
    return JSON.parse(stdout) as PRMetadata;
  } catch {
    throw new GitHubError(
      `Failed to parse PR metadata: ${stdout.slice(0, 200)}`,
      "GH_ERROR"
    );
  }
}

/**
 * Handle gh CLI errors and throw appropriate GitHubError.
 */
function handleGhError(stderr: string, prNumber: number, repo?: string): never {
  const errorLower = stderr.toLowerCase();
  const repoDesc = repo ? ` in ${repo}` : "";

  if (
    errorLower.includes("could not resolve to a pullrequest") ||
    errorLower.includes("no pull requests found") ||
    errorLower.includes("http 404")
  ) {
    throw new GitHubError(`PR #${prNumber} not found${repoDesc}`, "PR_NOT_FOUND");
  }

  if (
    errorLower.includes("could not resolve to a repository") ||
    errorLower.includes("repository not found")
  ) {
    throw new GitHubError(
      `Repository not found: ${repo || "(current)"}`,
      "REPO_NOT_FOUND"
    );
  }

  if (errorLower.includes("not logged in") || errorLower.includes("authentication")) {
    throw new GitHubError(
      "Not authenticated with GitHub. Run `gh auth login` to authenticate.",
      "NOT_AUTHENTICATED"
    );
  }

  if (
    errorLower.includes("not a git repository") ||
    errorLower.includes("could not determine current repository")
  ) {
    throw new GitHubError(
      "Not in a git repository. Use -R owner/repo to specify the repository.",
      "NOT_IN_REPO"
    );
  }

  throw new GitHubError(`gh error: ${stderr.trim()}`, "GH_ERROR");
}

/**
 * Assemble stated intent from PR metadata.
 *
 * Combines PR title, body, and commit messages into a structured format
 * suitable for passing to the analysis pipeline.
 *
 * @param pr - PR metadata
 * @returns Formatted stated intent string
 */
export function assemblePrIntent(pr: PRMetadata): string {
  const sections: string[] = [];

  // PR title is the primary summary
  sections.push(`PR Title: ${pr.title}`);
  sections.push(`Author: ${pr.author.name || pr.author.login}`);
  sections.push(`Branch: ${pr.headRefName} → ${pr.baseRefName}`);

  // PR body is the detailed intent
  if (pr.body?.trim()) {
    sections.push("");
    sections.push("PR Description:");
    sections.push(pr.body.trim());
  }

  // Commit messages add granular intent (useful for multi-commit PRs)
  if (pr.commits.length > 1) {
    sections.push("");
    sections.push(`Commits (${pr.commits.length}):`);
    for (const commit of pr.commits) {
      sections.push(`  - ${commit.messageHeadline}`);
      if (commit.messageBody?.trim()) {
        // Indent body
        const indented = commit.messageBody
          .trim()
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n");
        sections.push(indented);
      }
    }
  }

  return sections.join("\n");
}
