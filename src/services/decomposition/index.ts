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

// Two-pass types
export type { OverviewResult, TwoPassAnalysisResult } from "./two-pass.js";

// Flow detection types
export type {
  DetectedFlow,
  FlowDetectionResult,
  FlowDetectionResponse,
} from "./flow-detection.js";

// Flow analysis types
export type {
  FlowAnalysisResult,
  FlowBasedAnalysisResult,
} from "./flow-analysis.js";

// Strategy selection
export { calculateDiffMetrics, selectStrategy } from "./strategy-selector.js";

// Two-pass analysis
export {
  runTwoPassAnalysis,
  runOverviewPass,
  runDeepDivePass,
  mergeResults,
  buildOverviewPrompt,
  buildDeepDivePrompt,
} from "./two-pass.js";

// Flow detection (large diffs)
export {
  detectFlows,
  buildFlowDetectionPrompt,
  getFilesForFlow,
  getUncategorizedFiles,
  estimateFlowTokens,
} from "./flow-detection.js";

// Flow-based analysis (large diffs)
export {
  runFlowBasedAnalysis,
  analyzeFlow,
  analyzeAllFlows,
  synthesizeFlowResults,
  filterDiffForFlow,
  filterClassifiedForFlow,
  buildSynthesisPrompt,
} from "./flow-analysis.js";
