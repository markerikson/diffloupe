/**
 * Request and response shapes for the local server's HTTP API, and the event
 * stream a run produces. Type-only.
 */
import type { ReviewEvent } from "../review/core/pipeline.ts";
import type { ReviewModelStage } from "../review/options.ts";

/** Body of `POST /api/runs`. Also what the CLI hands the run manager directly. */
export interface StartRunRequest {
  /** Target spec; see parseTargetSpec. Defaults to the working tree. */
  target?: string;
  /** Repository root. Defaults to the server's repository. */
  repo?: string;
  base?: string;
  intent?: string;
  models?: Partial<Record<ReviewModelStage, string>>;
  effort?: string;
  maxCostUsd?: number;
  /** Per-repo settings file; see review/settings.ts. */
  settingsFile?: string;
}

export interface StartRunResponse {
  id: string;
  url: string;
}

/** Events the run manager adds around the core's own. */
export type RunEvent =
  | ReviewEvent
  | {
      type: "done";
      status: "complete";
      /** All findings in run.json, carried-over ones included. */
      findings: number;
      /** Findings carried over from the prior run of the same target. Absent in older event logs. */
      carriedOver?: number;
      costUsd: number;
      wallMs: number;
      /** The target held no reviewable code; nothing was sent to a model. */
      noChanges?: boolean;
    }
  | { type: "cancelled" }
  | { type: "error"; message: string };

/** One line of `events.jsonl`, and one SSE message. */
export type StoredEvent = RunEvent & { seq: number; at: string };

export type TerminalEventType = "done" | "cancelled" | "error";

export interface HealthResponse {
  app: "diffloupe";
  version: string;
  pid: number;
  defaultRepo: string | null;
  activeRunId: string | null;
  gh: { available: boolean; authed: boolean; message?: string };
  opencode: { path: string | null; version: string | null };
}

export interface ErrorResponse {
  error: string;
  activeRunId?: string;
}
