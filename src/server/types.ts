/**
 * Server Types - Type definitions for the HTTP API
 */

import type { ParsedDiff } from "../types/diff.js";
import type { DerivedIntent, RiskAssessment, IntentAlignment } from "../types/analysis.js";
import type { DecompositionStrategy } from "../services/decomposition/types.js";

/** Request body for the analyze endpoint */
export interface AnalyzeRequest {
  /** What to diff: "staged", "HEAD", "commit:abc", "branch:main", etc. */
  target: string;
  /** Optional stated intent from the author */
  statedIntent?: string | undefined;
  /** Working directory for git operations */
  cwd?: string | undefined;
  /** Force a specific decomposition strategy */
  strategy?: DecompositionStrategy | undefined;
}

/** Status of an analysis job */
export type AnalysisJobStatus = "pending" | "analyzing" | "complete" | "error";

/** Machine-readable progress status for tracking analysis phases */
export type ProgressStatus =
  | "fetching_diff"
  | "parsing"
  | "gathering_context"
  | "selecting_strategy"
  | "analyzing_overview"      // Two-pass: pass 1
  | "analyzing_deepdive"      // Two-pass: pass 2
  | "detecting_flows"         // Flow-based
  | "analyzing_flow"          // Flow-based: per-flow
  | "synthesizing"            // Flow-based: combining results
  | "analyzing_intent"        // Direct strategy
  | "analyzing_risks"         // Direct strategy
  | "analyzing_alignment"     // If stated intent provided
  | "complete"
  | "error";

/** Structured progress information for analysis */
export interface AnalysisProgress {
  /** Machine-readable status enum */
  status: ProgressStatus;
  /** Overall progress percentage (0-100) */
  percent: number;
  /** Human-readable status message */
  message: string;
  /** Optional additional detail (e.g., "Flow 2/4: Authentication") */
  detail?: string;
}

/** Full analysis result returned by the API */
export interface AnalysisResult {
  /** The parsed diff */
  diff: ParsedDiff;
  /** AI-derived intent of the changes */
  derivedIntent: DerivedIntent;
  /** Risk assessment */
  risks: RiskAssessment;
  /** Intent alignment (only if statedIntent was provided) */
  alignment?: IntentAlignment | undefined;
  /** Which decomposition strategy was used */
  strategy: DecompositionStrategy;
  /** Repository context that was gathered */
  repositoryContext?: string | undefined;
}

/** An analysis job (for async API) */
export interface AnalysisJob {
  id: string;
  status: AnalysisJobStatus;
  /** Structured progress information */
  progress?: AnalysisProgress | undefined;
  /** Result when complete */
  result?: AnalysisResult | undefined;
  /** Error message if failed */
  error?: string | undefined;
  /** When the job was created */
  createdAt: Date;
}

/** Response for job creation */
export interface CreateJobResponse {
  id: string;
}

/** Response for job status */
export interface JobStatusResponse {
  id: string;
  status: AnalysisJobStatus;
  progress?: AnalysisProgress | undefined;
  result?: AnalysisResult | undefined;
  error?: string | undefined;
}

/** Health check response */
export interface HealthResponse {
  status: "ok";
}

/** Error response */
export interface ErrorResponse {
  error: string;
  code?: string;
}
