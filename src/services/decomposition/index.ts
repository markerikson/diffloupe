/**
 * Diff decomposition module for handling large diffs.
 *
 * This module provides infrastructure for selecting and executing
 * different analysis strategies based on diff size:
 * - direct: Small diffs analyzed in one pass
 * - two-pass: Overview → targeted deep-dive (medium diffs)
 * - flow-based: Detect flows → per-flow analysis → synthesis (large diffs)
 * - hierarchical: File summaries → grouping → synthesis (huge diffs)
 */

// Types
export type {
  DecompositionStrategy,
  DiffMetrics,
  StrategySelection,
  FileChunk,
} from "./types.js";

// Strategy selection
export { calculateDiffMetrics, selectStrategy } from "./strategy-selector.js";
