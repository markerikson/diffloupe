/**
 * Shared utilities for formatting diff content in prompts
 *
 * These functions are used by both intent.ts and risks.ts to format
 * diff files and hunks for LLM analysis.
 *
 * ## Design Notes
 *
 * - Keeps standard diff format (+/-/space) since LLMs are trained on diffs
 * - Integrates deleted file summarization for large deletions (>100 lines)
 * - Clear separation between full diff formatting and summarized formatting
 */

import type { DiffFile, DiffHunk } from "../types/diff.js";
import {
  shouldSummarizeDeletedFile,
  summarizeDeletedFile,
  formatDeletedFileSummary,
} from "../services/deleted-file-summary.js";

/**
 * Format a diff hunk with its lines.
 *
 * We keep the standard diff format (+/-/space) because:
 * 1. LLMs are trained on lots of diffs in this format
 * 2. It's compact and information-dense
 * 3. The prefixes make add/remove/context visually clear
 */
export function formatHunk(hunk: DiffHunk): string {
  const lines: string[] = [hunk.header];

  for (const line of hunk.lines) {
    const prefix =
      line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
    lines.push(`${prefix}${line.content}`);
  }

  return lines.join("\n");
}

/**
 * Format a single diff file for inclusion in the prompt.
 *
 * For deleted files over 100 lines, uses summarization (header + signatures)
 * instead of full content to save tokens.
 *
 * We include:
 * - File path and status (added/modified/deleted/renamed)
 * - The actual diff hunks with context (or summary for large deletions)
 */
export function formatDiffFile(file: DiffFile): string {
  // Check if this is a large deleted file that should be summarized
  if (shouldSummarizeDeletedFile(file)) {
    const summary = summarizeDeletedFile(file);
    return formatDeletedFileSummary(file, summary);
  }

  const lines: string[] = [];

  // Header with path and status
  const statusLabel = file.status.toUpperCase();
  if (file.status === "renamed" && file.oldPath) {
    lines.push(`=== ${file.oldPath} → ${file.path} (${statusLabel}) ===`);
  } else {
    lines.push(`=== ${file.path} (${statusLabel}) ===`);
  }

  // Binary files have no hunks
  if (file.isBinary) {
    lines.push("[binary file]");
    return lines.join("\n");
  }

  // Include each hunk
  for (const hunk of file.hunks) {
    lines.push(formatHunk(hunk));
  }

  return lines.join("\n");
}
