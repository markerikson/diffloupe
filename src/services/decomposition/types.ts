import type { ClassifiedFile } from "../../types/loader.js";

/**
 * Strategy for analyzing a diff based on its size/complexity.
 * - direct: Small diffs analyzed in one pass (current approach)
 * - two-pass: Quick overview → targeted deep-dive
 * - flow-based: Detect logical flows → per-flow analysis → synthesis
 * - hierarchical: File summaries → flow grouping → synthesis (for huge diffs)
 */
export type DecompositionStrategy =
  | "direct"
  | "two-pass"
  | "flow-based"
  | "hierarchical";

/**
 * Metrics about a diff used to select decomposition strategy.
 */
export interface DiffMetrics {
  /** Number of files in the diff */
  fileCount: number;
  /** Total lines changed (adds + deletes) */
  totalLines: number;
  /** Estimated token count for the entire diff */
  estimatedTokens: number;
  /** Number of tier-1 (high-priority) files */
  tier1FileCount: number;
}

/**
 * Result of strategy selection, including the chosen strategy and why.
 */
export interface StrategySelection {
  /** The selected decomposition strategy */
  strategy: DecompositionStrategy;
  /** Human-readable reason for this selection */
  reason: string;
  /** The metrics used to make this decision */
  metrics: DiffMetrics;
}

/**
 * A chunk of files to be analyzed together (for decomposed analysis).
 */
export interface FileChunk {
  /** Name of this chunk (e.g., "auth-flow", "data-layer") */
  name: string;
  /** Files in this chunk */
  files: ClassifiedFile[];
  /** Estimated tokens for this chunk */
  estimatedTokens: number;
}
