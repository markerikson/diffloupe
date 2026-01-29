import type { ParsedDiff } from "../../types/diff.js";
import type { ClassifiedFile } from "../../types/loader.js";
import type { DiffMetrics, StrategySelection } from "./types.js";

// ============================================================================
// Thresholds from design doc (Section 5: Recommended Approach)
// ============================================================================

/** Maximum files for direct analysis (inclusive) */
const SMALL_FILE_THRESHOLD = 15;

/** Maximum tokens for direct analysis (inclusive) */
const SMALL_TOKEN_THRESHOLD = 8000;

/** Maximum files for two-pass analysis (inclusive) */
const MEDIUM_FILE_THRESHOLD = 40;

/** Maximum files for flow-based analysis (inclusive) */
const LARGE_FILE_THRESHOLD = 80;

// ============================================================================
// Metrics calculation
// ============================================================================

/**
 * Count total lines changed (additions + deletions) in a diff.
 */
function countChangedLines(diff: ParsedDiff): number {
  let total = 0;
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "add" || line.type === "delete") {
          total++;
        }
      }
    }
  }
  return total;
}

/**
 * Calculate metrics about a diff for strategy selection.
 *
 * @param diff The parsed diff
 * @param classified The classified files (with tier and token estimates)
 * @returns Metrics used to select decomposition strategy
 */
export function calculateDiffMetrics(
  diff: ParsedDiff,
  classified: ClassifiedFile[]
): DiffMetrics {
  const fileCount = classified.length;
  const totalLines = countChangedLines(diff);
  const estimatedTokens = classified.reduce(
    (sum, cf) => sum + cf.estimatedTokens,
    0
  );
  const tier1FileCount = classified.filter((cf) => cf.tier === 1).length;

  return {
    fileCount,
    totalLines,
    estimatedTokens,
    tier1FileCount,
  };
}

// ============================================================================
// Strategy selection
// ============================================================================

/**
 * Select the decomposition strategy based on diff metrics.
 *
 * Thresholds:
 * - Small (≤15 files OR ≤8k tokens): direct
 * - Medium (16-40 files): two-pass
 * - Large (41-80 files): flow-based
 * - Huge (>80 files): hierarchical
 *
 * @param metrics The diff metrics
 * @returns The selected strategy with reason
 */
export function selectStrategy(metrics: DiffMetrics): StrategySelection {
  const { fileCount, estimatedTokens } = metrics;

  // Small diff: direct analysis
  if (fileCount <= SMALL_FILE_THRESHOLD || estimatedTokens <= SMALL_TOKEN_THRESHOLD) {
    return {
      strategy: "direct",
      reason:
        fileCount <= SMALL_FILE_THRESHOLD
          ? `Small diff (${fileCount} files ≤ ${SMALL_FILE_THRESHOLD})`
          : `Low token count (${estimatedTokens} ≤ ${SMALL_TOKEN_THRESHOLD})`,
      metrics,
    };
  }

  // Medium diff: two-pass analysis
  if (fileCount <= MEDIUM_FILE_THRESHOLD) {
    return {
      strategy: "two-pass",
      reason: `Medium diff (${fileCount} files, ${SMALL_FILE_THRESHOLD + 1}-${MEDIUM_FILE_THRESHOLD} range)`,
      metrics,
    };
  }

  // Large diff: flow-based analysis
  if (fileCount <= LARGE_FILE_THRESHOLD) {
    return {
      strategy: "flow-based",
      reason: `Large diff (${fileCount} files, ${MEDIUM_FILE_THRESHOLD + 1}-${LARGE_FILE_THRESHOLD} range)`,
      metrics,
    };
  }

  // Huge diff: hierarchical analysis
  return {
    strategy: "hierarchical",
    reason: `Huge diff (${fileCount} files > ${LARGE_FILE_THRESHOLD})`,
    metrics,
  };
}
