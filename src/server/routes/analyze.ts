/**
 * Analyze Routes - API endpoints for diff analysis
 */

import { Hono } from "hono";
import type {
  AnalyzeRequest,
  CreateJobResponse,
  JobStatusResponse,
  AnalysisResult,
  ErrorResponse,
} from "../types.js";
import { runAnalysis, NoChangesError, MissingAPIKeyError } from "../services/analyzer.js";
import {
  createJob,
  getJob,
  updateJobStatus,
  updateJobProgress,
  completeJob,
  failJob,
} from "../services/job-store.js";
import { GitError } from "../../types/git.js";
import { LLMAPIKeyError, LLMGenerationError } from "../../types/llm.js";

const analyzeRoutes = new Hono();

/**
 * Map errors to HTTP-friendly error responses
 */
function mapError(error: unknown): { status: number; body: ErrorResponse } {
  if (error instanceof NoChangesError) {
    return { status: 404, body: { error: error.message, code: "NO_CHANGES" } };
  }
  if (error instanceof MissingAPIKeyError) {
    return { status: 500, body: { error: error.message, code: "MISSING_API_KEY" } };
  }
  if (error instanceof GitError) {
    const status = error.code === "NOT_A_REPO" ? 400 : 500;
    return { status, body: { error: error.message, code: error.code } };
  }
  if (error instanceof LLMAPIKeyError) {
    return { status: 500, body: { error: error.message, code: "INVALID_API_KEY" } };
  }
  if (error instanceof LLMGenerationError) {
    return { status: 500, body: { error: error.message, code: "LLM_ERROR" } };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { error: message, code: "UNKNOWN_ERROR" } };
}

/**
 * Validate analyze request body
 */
function validateRequest(body: unknown): AnalyzeRequest | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const obj = body as Record<string, unknown>;

  // target is required - use bracket notation for index signature
  const target = obj["target"];
  if (typeof target !== "string" || !target.trim()) {
    return null;
  }

  const statedIntent = obj["statedIntent"];
  const cwd = obj["cwd"];
  const strategy = obj["strategy"];

  const validStrategies = ["direct", "two-pass", "flow-based", "hierarchical"];
  const validatedStrategy =
    typeof strategy === "string" && validStrategies.includes(strategy)
      ? (strategy as AnalyzeRequest["strategy"])
      : undefined;

  return {
    target: target.trim(),
    statedIntent: typeof statedIntent === "string" ? statedIntent : undefined,
    cwd: typeof cwd === "string" ? cwd : undefined,
    strategy: validatedStrategy,
  };
}

/**
 * POST /api/analyze/sync
 *
 * Synchronous analysis - waits for analysis to complete and returns results.
 * Simpler API but blocks until done.
 */
analyzeRoutes.post("/sync", async (c) => {
  const body = await c.req.json().catch(() => null);
  const request = validateRequest(body);

  if (!request) {
    return c.json({ error: "Invalid request. 'target' is required." } satisfies ErrorResponse, 400);
  }

  try {
    const result = await runAnalysis({
      target: request.target,
      statedIntent: request.statedIntent,
      cwd: request.cwd,
      strategy: request.strategy,
    });

    return c.json(result satisfies AnalysisResult);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status as 400 | 404 | 500);
  }
});

/**
 * POST /api/analyze
 *
 * Async analysis - starts a job and returns immediately with job ID.
 * Poll GET /api/analyze/:id for status and results.
 */
analyzeRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const request = validateRequest(body);

  if (!request) {
    return c.json({ error: "Invalid request. 'target' is required." } satisfies ErrorResponse, 400);
  }

  // Create job
  const job = createJob();

  // Start analysis in background (don't await)
  runAnalysisAsync(job.id, request);

  return c.json({ id: job.id } satisfies CreateJobResponse, 202);
});

/**
 * GET /api/analyze/:id
 *
 * Get job status and results
 */
analyzeRoutes.get("/:id", (c) => {
  const id = c.req.param("id");
  const job = getJob(id);

  if (!job) {
    return c.json({ error: `Job not found: ${id}` } satisfies ErrorResponse, 404);
  }

  const response: JobStatusResponse = {
    id: job.id,
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.error,
  };

  return c.json(response);
});

/**
 * Run analysis asynchronously and update job status
 */
async function runAnalysisAsync(jobId: string, request: AnalyzeRequest): Promise<void> {
  try {
    updateJobStatus(jobId, "analyzing", "Starting analysis...");

    const result = await runAnalysis({
      target: request.target,
      statedIntent: request.statedIntent,
      cwd: request.cwd,
      strategy: request.strategy,
      onProgress: (message) => {
        updateJobProgress(jobId, message);
      },
    });

    completeJob(jobId, result);
  } catch (error) {
    const { body } = mapError(error);
    failJob(jobId, body.error);
  }
}

export { analyzeRoutes };
