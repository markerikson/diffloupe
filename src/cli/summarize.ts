/**
 * Summarize Command - Preview diff formatting without LLM call
 *
 * Shows what DiffLoupe would send to the LLM, including:
 * - File list with status and line counts
 * - Token estimates (original vs with summarization)
 * - Formatted diff content
 *
 * Useful for debugging, token budgeting, and understanding the analysis pipeline.
 */

import { Command } from "commander";
import pc from "picocolors";

import type { DiffFile } from "../types/diff.js";
import type { ClassifiedFile } from "../types/loader.js";
import { getDiff } from "../services/git.js";
import { parseDiff } from "../services/diff-parser.js";
import { classifyDiff } from "../services/diff-loader.js";
import { formatDiffFile } from "../utils/format-diff.js";
import {
  estimateDiffTokens,
  type DiffTokenEstimate,
} from "../utils/token-estimate.js";
import { shouldSummarizeDeletedFile } from "../services/deleted-file-summary.js";
import { GitError } from "../types/git.js";

export interface SummarizeOptions {
  target: string;
  stats: boolean;
  full: boolean;
  json: boolean;
  noTokens: boolean;
  filesOnly: boolean;
  cwd?: string;
}

interface SummarizeJsonOutput {
  files: Array<{
    path: string;
    status: string;
    tier: number;
    lines: number;
    summarized: boolean;
    tokens: {
      original: number;
      withSummarization: number;
    };
  }>;
  totals: {
    files: number;
    tier1: number;
    tier2: number;
    excluded: number;
    tokens: {
      original: number;
      withSummarization: number;
      savings: number;
      savingsPercent: number;
    };
  };
  content?: string;
}

/**
 * Count lines in a diff file (deleted lines for deleted files, all changed lines otherwise)
 */
function countLines(file: DiffFile): number {
  if (file.status === "deleted") {
    return file.hunks.reduce(
      (sum, h) => sum + h.lines.filter((l) => l.type === "delete").length,
      0
    );
  }
  // For other files, count added + deleted lines
  return file.hunks.reduce(
    (sum, h) =>
      sum + h.lines.filter((l) => l.type === "add" || l.type === "delete").length,
    0
  );
}

/**
 * Format the file list section
 */
function formatFileList(
  classified: ClassifiedFile[],
  _tokenEstimates: DiffTokenEstimate
): string {
  const lines: string[] = [];

  const tier1 = classified.filter((c) => c.tier === 1).length;
  const tier2 = classified.filter((c) => c.tier === 2).length;
  const tier3 = classified.filter((c) => c.tier === 3).length;

  lines.push(
    pc.bold(
      `Files (${classified.length} total: ${tier1} Tier 1, ${tier2} Tier 2, ${tier3} excluded):`
    )
  );

  // Sort by tier, then by path
  const sorted = [...classified].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.file.path.localeCompare(b.file.path);
  });

  for (const cf of sorted) {
    const file = cf.file;
    const lineCount = countLines(file);
    const status = file.status.toUpperCase().padEnd(8);
    const summarized = shouldSummarizeDeletedFile(file);

    // Color based on status
    let statusColored: string;
    switch (file.status) {
      case "added":
        statusColored = pc.green(status);
        break;
      case "deleted":
        statusColored = pc.red(status);
        break;
      case "renamed":
        statusColored = pc.yellow(status);
        break;
      default:
        statusColored = pc.blue(status);
    }

    // Tier indicator
    const tierIndicator = cf.tier === 3 ? pc.dim(" [excluded]") : "";
    const summarizedIndicator = summarized ? pc.cyan(" [summarized]") : "";

    lines.push(
      `  ${statusColored} ${file.path} (${lineCount} lines)${summarizedIndicator}${tierIndicator}`
    );
  }

  return lines.join("\n");
}

/**
 * Format the token estimate section
 */
function formatTokenEstimate(estimate: DiffTokenEstimate): string {
  const lines: string[] = [];
  const { totals } = estimate;

  lines.push(pc.bold("Token Estimate:"));
  lines.push(`  Original:     ${totals.original.toLocaleString()} tokens`);
  lines.push(
    `  Summarized:   ${totals.withSummarization.toLocaleString()} tokens`
  );

  if (totals.savings > 0) {
    lines.push(
      pc.green(
        `  Savings:      ${totals.savings.toLocaleString()} tokens (${totals.savingsPercent}%)`
      )
    );
  }

  return lines.join("\n");
}

/**
 * Format the diff content section
 */
function formatDiffContent(classified: ClassifiedFile[]): string {
  const lines: string[] = [];

  // Only include Tier 1 and Tier 2 files
  const relevant = classified.filter((cf) => cf.tier <= 2);

  for (const cf of relevant) {
    lines.push(formatDiffFile(cf.file));
    lines.push(""); // blank line between files
  }

  return lines.join("\n");
}

/**
 * Build JSON output structure
 */
function buildJsonOutput(
  classified: ClassifiedFile[],
  tokenEstimates: DiffTokenEstimate,
  options: SummarizeOptions
): SummarizeJsonOutput {
  const files = classified.map((cf) => {
    const file = cf.file;
    const estimate = tokenEstimates.files.find((f) => f.path === file.path);

    return {
      path: file.path,
      status: file.status,
      tier: cf.tier,
      lines: countLines(file),
      summarized: shouldSummarizeDeletedFile(file),
      tokens: estimate
        ? {
            original: estimate.estimate.original,
            withSummarization: estimate.estimate.withSummarization,
          }
        : { original: 0, withSummarization: 0 },
    };
  });

  const output: SummarizeJsonOutput = {
    files,
    totals: {
      files: classified.length,
      tier1: classified.filter((c) => c.tier === 1).length,
      tier2: classified.filter((c) => c.tier === 2).length,
      excluded: classified.filter((c) => c.tier === 3).length,
      tokens: tokenEstimates.totals,
    },
  };

  // Add content unless --stats or --files-only
  if (!options.stats && !options.filesOnly) {
    output.content = formatDiffContent(classified);
  }

  return output;
}

/**
 * Main summarize action
 */
async function summarizeAction(
  target: string,
  options: Omit<SummarizeOptions, "target">
): Promise<void> {
  const opts: SummarizeOptions = { target, ...options };

  try {
    // Step 1: Get the diff
    console.error(pc.dim(`Fetching ${opts.target} diff...`));
    const diffResult = await getDiff(opts.target, opts.cwd);

    // Handle empty diff
    if (!diffResult.hasChanges) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              files: [],
              totals: {
                files: 0,
                tier1: 0,
                tier2: 0,
                excluded: 0,
                tokens: {
                  original: 0,
                  withSummarization: 0,
                  savings: 0,
                  savingsPercent: 0,
                },
              },
            },
            null,
            2
          )
        );
      } else {
        console.log(pc.yellow("\nNo changes found."));
        if (opts.target === "unstaged") {
          console.log(
            pc.dim("Make some changes first, or try:\n") +
              pc.dim("  diffloupe summarize --staged\n") +
              pc.dim("  diffloupe summarize HEAD~1")
          );
        }
      }
      return;
    }

    // Step 2: Parse and classify
    const parsed = parseDiff(diffResult.diff);
    const classified = classifyDiff(parsed);

    // Step 3: Calculate token estimates
    const relevantFiles = classified
      .filter((cf) => cf.tier <= 2)
      .map((cf) => cf.file);
    const tokenEstimates = estimateDiffTokens(relevantFiles);

    // Step 4: Output based on format
    if (opts.json) {
      const output = buildJsonOutput(classified, tokenEstimates, opts);
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    // Text output
    const sections: string[] = [];

    sections.push(pc.bold(pc.cyan("=== DIFF SUMMARY ===")));
    sections.push("");

    // File list (always shown unless pure content mode)
    sections.push(formatFileList(classified, tokenEstimates));
    sections.push("");

    // Token estimate (unless --no-tokens)
    if (!opts.noTokens) {
      sections.push(formatTokenEstimate(tokenEstimates));
      sections.push("");
    }

    // Diff content (unless --stats or --files-only)
    if (!opts.stats && !opts.filesOnly) {
      sections.push(pc.bold(pc.cyan("=== DIFF CONTENT ===")));
      sections.push("");
      sections.push(formatDiffContent(classified));
    }

    console.log(sections.join("\n"));
  } catch (error) {
    if (error instanceof GitError) {
      console.error(pc.red(`Git error: ${error.message}`));
      if (error.code === "NOT_A_REPO") {
        console.error(pc.dim("Run this command from within a git repository."));
      }
      process.exit(1);
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(`Error: ${message}`));
    process.exit(1);
  }
}

/**
 * Create the summarize command
 */
export function createSummarizeCommand(): Command {
  return new Command("summarize")
    .description("Preview diff formatting without running LLM analysis")
    .argument(
      "[target]",
      "What to diff: unstaged, staged, HEAD, branch:name, commit:hash, or range:a..b",
      "unstaged"
    )
    .option("--stats", "Show only file list and token estimates", false)
    .option("--full", "Include system prompt framing (not yet implemented)", false)
    .option("--json", "Output as JSON", false)
    .option("--no-tokens", "Skip token estimates")
    .option("--files-only", "Show only file list", false)
    .option("-C, --cwd <path>", "Run as if started in <path>")
    .action(summarizeAction);
}
