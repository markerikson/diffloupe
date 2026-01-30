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
  /** Progress message (e.g., "Parsing diff...", "Analyzing with AI...") */
  progress?: string | undefined;
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
  progress?: string | undefined;
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
