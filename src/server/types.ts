/**
 * Request and response shapes for the local server's HTTP API, and the event
 * stream a run produces. Shared with the web UI, so this file imports nothing
 * from the review core; `schema-drift.ts` checks the copies stay in sync.
 */
import { type } from "arktype";
import { RunGroupSchema, RunKindSchema } from "../types/review-run.ts";

/**
 * Body of `POST /api/runs`. Also what the CLI hands the run manager directly.
 * `target` is a spec for parseTargetSpec and defaults to the working tree;
 * `repo` defaults to the server's repository; `settingsFile` is a per-repo
 * settings file (see review/settings.ts).
 */
export const StartRunRequestSchema = type({
  "+": "reject",
  "target?": "string",
  "repo?": "string",
  "base?": "string",
  "intent?": "string",
  "models?": {
    "+": "reject",
    "review?": "string",
    "coordinator?": "string",
    "walkthrough?": "string",
    "intent?": "string",
  },
  "effort?": "string",
  "maxCostUsd?": "number > 0",
  "settingsFile?": "string",
  "kind?": RunKindSchema,
  /** Diff runs only: add the walkthrough guide. */
  "walkthrough?": "boolean",
  /**
   * Run the same base and head as this earlier run, instead of resolving
   * `target` again. A working-tree run keeps the snapshot it was given.
   */
  "fromRun?": "string",
  /** A re-review normally looks only at what changed since the prior run; this reviews everything. */
  "full?": "boolean",
});
export type StartRunRequest = typeof StartRunRequestSchema.infer;

export const StartRunResponseSchema = type({ id: "string", url: "string" });
export type StartRunResponse = typeof StartRunResponseSchema.infer;

export const ReviewStageSchema = type(
  "'resolving_target' | 'checking_registry' | 'building_map' | 'grouping' | 'reviewing' | 'coordinating' | 'walkthrough' | 'verifying' | 'writing'",
);
export type ReviewStage = typeof ReviewStageSchema.infer;

/** The review core's own events; mirrors `ReviewEvent` in review/core/pipeline.ts. */
export const CoreEventSchema = type({ type: "'stage'", stage: ReviewStageSchema })
  .or({
    type: "'slice'",
    index: "number",
    total: "number",
    title: "string",
    status: "'started' | 'ok' | 'failed'",
    "costUsd?": "number",
    "wallMs?": "number",
    "findings?": "number",
  })
  .or({ type: "'log'", message: "string" })
  .or({ type: "'cost'", totalUsd: "number" })
  .or({ type: "'budget'", totalUsd: "number", limitUsd: "number", skippedSlices: "number" });
export type CoreEvent = typeof CoreEventSchema.infer;

/**
 * The run's groups once the core has formed its review units: flat unit groups
 * plus the trailing docs and skipped section. Walkthrough chapters arrive only
 * with the finished run.
 */
export const GroupsEventSchema = type({
  type: "'groups'",
  groups: RunGroupSchema.array(),
  files: type({ path: "string", groupId: "string", classification: "'code' | 'docs' | 'skip'" }).array(),
});
export type GroupsEvent = typeof GroupsEventSchema.infer;

/**
 * Events the run manager adds around the core's own. On `done`, `findings`
 * counts every finding in run.json, carried-over ones included; `carriedOver`
 * is absent in older event logs; `noChanges` means the target held no
 * reviewable code and nothing was sent to a model. Diff runs set `kind` and
 * `files` (the changed file count).
 */
export const RunEventSchema = CoreEventSchema.or(GroupsEventSchema).or({
  type: "'done'",
  status: "'complete'",
  findings: "number",
  "carriedOver?": "number",
  costUsd: "number",
  wallMs: "number",
  "noChanges?": "boolean",
  "kind?": RunKindSchema,
  "files?": "number",
})
  .or({ type: "'cancelled'" })
  .or({ type: "'error'", message: "string" });
export type RunEvent = typeof RunEventSchema.infer;

/** One line of `events.jsonl`, and one SSE message. */
export const StoredEventSchema = RunEventSchema.and({ seq: "number", at: "string" });
export type StoredEvent = typeof StoredEventSchema.infer;

export type TerminalEventType = "done" | "cancelled" | "error";

export const HealthResponseSchema = type({
  app: "'diffloupe'",
  version: "string",
  pid: "number",
  defaultRepo: "string | null",
  activeRunId: "string | null",
  gh: { available: "boolean", authed: "boolean", "message?": "string" },
  opencode: { path: "string | null", version: "string | null" },
});
export type HealthResponse = typeof HealthResponseSchema.infer;

export const ErrorResponseSchema = type({ error: "string", "activeRunId?": "string" });
export type ErrorResponse = typeof ErrorResponseSchema.infer;
