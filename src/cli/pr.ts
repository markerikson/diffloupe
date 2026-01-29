/**
 * PR Command - Analyze GitHub PRs
 *
 * Fetches PR diff and metadata via `gh` CLI, then runs the standard
 * DiffLoupe analysis pipeline (intent derivation, risk assessment, alignment).
 */

import { Command } from "commander";
import pc from "picocolors";

import type { DerivedIntent, IntentAlignment, RiskAssessment } from "../types/analysis.js";
import type { PRMetadata } from "../types/github.js";
import { GitHubError } from "../types/github.js";
import {
  checkGhAvailable,
  fetchPrDiff,
  fetchPrMetadata,
  assemblePrIntent,
  fetchSiblingFilesFromGitHub,
} from "../services/github.js";
import { getChangedDirectories, formatContextSection } from "../services/context.js";
import { parseDiff } from "../services/diff-parser.js";
import { classifyDiff } from "../services/diff-loader.js";
import { deriveIntent } from "../prompts/intent.js";
import { assessRisks } from "../prompts/risks.js";
import { alignIntent } from "../prompts/alignment.js";
import { hasAPIKey } from "../services/llm.js";
import { LLMAPIKeyError, LLMGenerationError } from "../types/llm.js";
import { formatSummary, formatVerbose } from "./output.js";
import { spawn } from "../runtime/index.js";

export interface PROptions {
  prNumber: number;
  repo: string | undefined;
  verbose: boolean;
  json: boolean;
}

/**
 * Format PR header for output display.
 */
function formatPRHeader(pr: PRMetadata): string {
  const lines: string[] = [];
  const divider = pc.dim("─".repeat(60));

  lines.push(divider);
  lines.push(pc.bold(pc.cyan(`PR #${pr.number}: ${pr.title}`)));
  lines.push(divider);
  lines.push("");
  lines.push(`${pc.bold("Author:")}  ${pr.author.name || pr.author.login}`);
  lines.push(`${pc.bold("URL:")}     ${pc.blue(pr.url)}`);
  lines.push(`${pc.bold("Branch:")}  ${pr.headRefName} → ${pr.baseRefName}`);
  lines.push(`${pc.bold("State:")}   ${formatState(pr.state)}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Color PR state appropriately.
 */
function formatState(state: PRMetadata["state"]): string {
  switch (state) {
    case "OPEN":
      return pc.green(state);
    case "MERGED":
      return pc.magenta(state);
    case "CLOSED":
      return pc.red(state);
  }
}

/**
 * Output analysis results in the appropriate format.
 */
function outputResults(
  pr: PRMetadata,
  intent: DerivedIntent,
  risks: RiskAssessment,
  statedIntent: string,
  alignment: IntentAlignment,
  options: PROptions
): void {
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          pr: {
            number: pr.number,
            title: pr.title,
            author: pr.author,
            url: pr.url,
            state: pr.state,
            branch: {
              head: pr.headRefName,
              base: pr.baseRefName,
            },
          },
          statedIntent,
          intent,
          risks,
          alignment,
        },
        null,
        2
      )
    );
  } else {
    // Print PR header first
    console.log(formatPRHeader(pr));

    // Then the standard analysis output
    if (options.verbose) {
      console.log(formatVerbose(intent, risks, statedIntent, alignment));
    } else {
      console.log(formatSummary(intent, risks, statedIntent, alignment));
    }
  }
}

/**
 * Get current repository name from gh CLI.
 */
async function getCurrentRepo(): Promise<string> {
  const { stdout, exitCode } = await spawn("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);

  if (exitCode !== 0) {
    throw new GitHubError(
      "Could not determine current repository. Use -R owner/repo to specify.",
      "NOT_IN_REPO"
    );
  }

  return stdout.trim();
}

/**
 * Parse a GitHub PR URL and extract owner, repo, and PR number.
 * Supports:
 * - https://github.com/owner/repo/pull/123
 * - https://github.com/owner/repo/pull/123/files (with trailing path)
 * - http://github.com/... (http variant)
 * - github.com/owner/repo/pull/123 (without protocol)
 *
 * Returns null if not a valid GitHub PR URL.
 */
export function parseGitHubPRUrl(
  url: string
): { owner: string; repo: string; prNumber: number } | null {
  // Normalize: add https:// if no protocol
  let normalized = url;
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    normalized = `https://${normalized}`;
  }

  // Try to parse as URL
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  // Must be github.com
  if (parsed.hostname !== "github.com") {
    return null;
  }

  // Path should be /owner/repo/pull/number[/...]
  // Remove leading slash and split
  const parts = parsed.pathname.slice(1).split("/");

  // Need at least: owner, repo, "pull", number
  if (parts.length < 4 || parts[2] !== "pull") {
    return null;
  }

  const owner = parts[0];
  const repo = parts[1];
  const prNumberStr = parts[3];

  if (!owner || !repo || !prNumberStr) {
    return null;
  }

  const prNumber = parseInt(prNumberStr, 10);
  if (isNaN(prNumber)) {
    return null;
  }

  return { owner, repo, prNumber };
}

/**
 * Parse PR identifier which can be:
 * - A number: 123
 * - owner/repo#number: reduxjs/redux-toolkit#4567
 * - GitHub URL: https://github.com/owner/repo/pull/123
 */
export function parsePRIdentifier(
  identifier: string,
  repoOption: string | undefined
): { prNumber: number; repo: string | undefined } {
  // Check for GitHub URL format first
  const urlParsed = parseGitHubPRUrl(identifier);
  if (urlParsed) {
    return {
      repo: `${urlParsed.owner}/${urlParsed.repo}`,
      prNumber: urlParsed.prNumber,
    };
  }

  // Check for owner/repo#number format
  const crossRepoMatch = identifier.match(/^([^#]+)#(\d+)$/);
  if (crossRepoMatch && crossRepoMatch[1] && crossRepoMatch[2]) {
    return {
      repo: crossRepoMatch[1],
      prNumber: parseInt(crossRepoMatch[2], 10),
    };
  }

  // Plain number
  const num = parseInt(identifier, 10);
  if (isNaN(num)) {
    throw new Error(
      `Invalid PR identifier: ${identifier}. Use a number, owner/repo#number, or GitHub URL.`
    );
  }

  return { prNumber: num, repo: repoOption };
}

/**
 * Create the PR command.
 */
export function createPRCommand(): Command {
  return new Command("pr")
    .description("Analyze a GitHub PR")
    .argument("<identifier>", "PR number, owner/repo#number, or GitHub URL")
    .option("-R, --repo <repo>", "Repository in owner/repo format")
    .option("-v, --verbose", "Show detailed output", false)
    .option("--json", "Output results as JSON", false)
    .action(async (identifier: string, options: Omit<PROptions, "prNumber">) => {
      try {
        // Parse the PR identifier
        const { prNumber, repo } = parsePRIdentifier(identifier, options.repo);
        const opts: PROptions = { ...options, prNumber, repo };

        // Step 1: Check gh CLI is available
        console.log(pc.dim("Checking gh CLI..."));
        await checkGhAvailable();

        // Step 2: Check for API key
        if (!hasAPIKey()) {
          console.error(
            pc.red("Error: ANTHROPIC_API_KEY environment variable is not set.\n") +
              pc.dim("Set it in your .env file or export it in your shell:\n") +
              pc.dim("  export ANTHROPIC_API_KEY=sk-ant-...")
          );
          process.exit(1);
        }

        // Step 3: Fetch PR metadata and diff in parallel
        console.log(pc.dim(`Fetching PR #${prNumber}...`));
        const [prMetadata, prDiff] = await Promise.all([
          fetchPrMetadata(prNumber, repo),
          fetchPrDiff(prNumber, repo),
        ]);

        // Handle empty diff
        if (!prDiff.trim()) {
          console.log(pc.yellow("\nPR has no file changes."));
          console.log(pc.dim(`URL: ${prMetadata.url}`));
          return;
        }

        // Step 4: Parse and classify the diff
        console.log(pc.dim("Parsing diff..."));
        const parsed = parseDiff(prDiff);
        const classified = classifyDiff(parsed);

        console.log(
          pc.dim(`Found ${parsed.files.length} file(s), analyzing with AI...`)
        );

        // Step 5: Assemble stated intent from PR metadata
        const statedIntent = assemblePrIntent(prMetadata);

        // Step 5.5: Gather repository context (sibling files in touched directories)
        // For PRs we fetch from GitHub API using the base branch tree
        const directories = getChangedDirectories(parsed);
        const repoName = repo || await getCurrentRepo();
        const siblings = await fetchSiblingFilesFromGitHub(directories, prMetadata.baseRefName, repoName);
        
        // Check if context gathering failed (siblings array may have .warning property)
        const warning = (siblings as { warning?: string }).warning;
        if (warning) {
          console.log(pc.yellow(`⚠ ${warning}`));
          console.log(pc.dim("  Analysis will continue but may flag false positives about missing files."));
        }
        
        const repositoryContext = formatContextSection(siblings);

        // Step 6: Run intent and risk analysis in parallel
        const [intent, risks] = await Promise.all([
          deriveIntent(parsed, classified, statedIntent, repositoryContext),
          assessRisks(parsed, classified, statedIntent, repositoryContext),
        ]);

        // Step 7: Run alignment analysis
        console.log(pc.dim("Analyzing intent alignment..."));
        const alignment = await alignIntent(statedIntent, intent, parsed, classified, repositoryContext);

        // Step 8: Output results
        console.log(""); // blank line before results
        outputResults(prMetadata, intent, risks, statedIntent, alignment, opts);
      } catch (error) {
        // Handle specific error types with friendly messages
        if (error instanceof GitHubError) {
          console.error(pc.red(`GitHub error: ${error.message}`));

          if (error.code === "GH_NOT_INSTALLED") {
            console.error(pc.dim("Install gh from https://cli.github.com/"));
          } else if (error.code === "NOT_AUTHENTICATED") {
            console.error(pc.dim("Run `gh auth login` to authenticate."));
          } else if (error.code === "NOT_IN_REPO") {
            console.error(pc.dim("Specify the repository with -R owner/repo"));
          }

          process.exit(1);
        }

        if (error instanceof LLMAPIKeyError) {
          console.error(
            pc.red("Error: Invalid or missing API key.\n") +
              pc.dim("Check that your ANTHROPIC_API_KEY is correct.")
          );
          process.exit(1);
        }

        if (error instanceof LLMGenerationError) {
          console.error(pc.red("Error: AI analysis failed.\n") + pc.dim(error.message));
          process.exit(1);
        }

        // Unknown error
        const message = error instanceof Error ? error.message : String(error);
        console.error(pc.red(`Error: ${message}`));
        process.exit(1);
      }
    });
}
