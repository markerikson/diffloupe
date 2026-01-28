/**
 * Token Estimation Utilities
 *
 * Simple heuristics for estimating token counts without requiring
 * a full tokenizer library. Uses char/4 approximation which is
 * reasonably accurate for English text and code.
 */

import type { DiffFile } from "../types/diff.js";
import {
  shouldSummarizeDeletedFile,
  summarizeDeletedFile,
  formatDeletedFileSummary,
} from "../services/deleted-file-summary.js";


/**
 * Estimate token count for a string using char/4 heuristic.
 *
 * This is a rough approximation - actual tokenization varies by model.
 * For Claude/GPT models, this tends to slightly overestimate for code
 * (which has more punctuation) and underestimate for prose.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface FileTokenEstimate {
  /** Tokens if showing full diff content */
  original: number;
  /** Tokens with summarization applied (same as original if not summarized) */
  withSummarization: number;
  /** Whether this file would be summarized */
  summarized: boolean;
}

/**
 * Estimate tokens for a single diff file, with and without summarization.
 */
export function estimateFileTokens(file: DiffFile): FileTokenEstimate {
  // Get full diff content
  const fullContent = file.hunks
    .flatMap((h) => h.lines.map((l) => l.content))
    .join("\n");
  const originalTokens = estimateTokens(fullContent);

  // Check if this file would be summarized
  if (shouldSummarizeDeletedFile(file)) {
    const summary = summarizeDeletedFile(file);
    const summarizedContent = formatDeletedFileSummary(file, summary);
    return {
      original: originalTokens,
      withSummarization: estimateTokens(summarizedContent),
      summarized: true,
    };
  }

  return {
    original: originalTokens,
    withSummarization: originalTokens,
    summarized: false,
  };
}

export interface DiffTokenEstimate {
  /** Per-file token estimates */
  files: Array<{
    path: string;
    estimate: FileTokenEstimate;
  }>;
  /** Aggregate totals */
  totals: {
    original: number;
    withSummarization: number;
    savings: number;
    savingsPercent: number;
  };
}

/**
 * Estimate tokens for an entire diff, including summarization savings.
 */
export function estimateDiffTokens(files: DiffFile[]): DiffTokenEstimate {
  const fileEstimates = files.map((file) => ({
    path: file.path,
    estimate: estimateFileTokens(file),
  }));

  const original = fileEstimates.reduce(
    (sum, f) => sum + f.estimate.original,
    0
  );
  const withSummarization = fileEstimates.reduce(
    (sum, f) => sum + f.estimate.withSummarization,
    0
  );
  const savings = original - withSummarization;

  return {
    files: fileEstimates,
    totals: {
      original,
      withSummarization,
      savings,
      savingsPercent: original > 0 ? Math.round((savings / original) * 100) : 0,
    },
  };
}
