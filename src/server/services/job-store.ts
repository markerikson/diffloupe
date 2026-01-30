/**
 * Job Store - In-memory storage for analysis jobs
 *
 * Simple in-memory store for tracking async analysis jobs.
 * Can be upgraded to SQLite or Redis later if needed.
 */

import type { AnalysisJob, AnalysisJobStatus, AnalysisResult } from "../types.js";

/** Generate a unique job ID */
function generateJobId(): string {
  // Simple unique ID: timestamp + random suffix
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

/** In-memory job storage */
const jobs = new Map<string, AnalysisJob>();

/** Maximum number of jobs to keep (prevents memory leak) */
const MAX_JOBS = 100;

/** How long to keep completed/errored jobs (1 hour) */
const JOB_TTL_MS = 60 * 60 * 1000;

/**
 * Create a new pending job
 */
export function createJob(): AnalysisJob {
  const job: AnalysisJob = {
    id: generateJobId(),
    status: "pending",
    createdAt: new Date(),
  };

  // Cleanup old jobs before adding new one
  cleanupOldJobs();

  jobs.set(job.id, job);
  return job;
}

/**
 * Get a job by ID
 */
export function getJob(id: string): AnalysisJob | undefined {
  return jobs.get(id);
}

/**
 * Update job status
 */
export function updateJobStatus(id: string, status: AnalysisJobStatus, progress?: string): void {
  const job = jobs.get(id);
  if (job) {
    job.status = status;
    if (progress !== undefined) {
      job.progress = progress;
    }
  }
}

/**
 * Update job progress message
 */
export function updateJobProgress(id: string, progress: string): void {
  const job = jobs.get(id);
  if (job) {
    job.progress = progress;
  }
}

/**
 * Complete a job with results
 */
export function completeJob(id: string, result: AnalysisResult): void {
  const job = jobs.get(id);
  if (job) {
    job.status = "complete";
    job.result = result;
    delete job.progress;
  }
}

/**
 * Fail a job with an error
 */
export function failJob(id: string, error: string): void {
  const job = jobs.get(id);
  if (job) {
    job.status = "error";
    job.error = error;
    delete job.progress;
  }
}

/**
 * Remove old jobs to prevent memory leak
 */
function cleanupOldJobs(): void {
  const now = Date.now();

  // If we have too many jobs, remove oldest completed/errored ones
  if (jobs.size >= MAX_JOBS) {
    const jobsArray = [...jobs.entries()];

    // Sort by creation time (oldest first)
    jobsArray.sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime());

    // Remove oldest jobs that are complete/errored
    for (const [id, job] of jobsArray) {
      if (jobs.size < MAX_JOBS) break;

      if (job.status === "complete" || job.status === "error") {
        jobs.delete(id);
      }
    }
  }

  // Remove jobs older than TTL
  for (const [id, job] of jobs.entries()) {
    const age = now - job.createdAt.getTime();
    if (age > JOB_TTL_MS && (job.status === "complete" || job.status === "error")) {
      jobs.delete(id);
    }
  }
}

/**
 * Get all jobs (for debugging)
 */
export function getAllJobs(): AnalysisJob[] {
  return [...jobs.values()];
}

/**
 * Clear all jobs (for testing)
 */
export function clearAllJobs(): void {
  jobs.clear();
}
