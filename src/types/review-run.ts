/**
 * The saved form of one review: what the CLI, the server and the UI read.
 * Built from the review core's output by `src/review/build-run.ts`, but has no
 * imports from the core so the web bundle can use it.
 *
 * Each type is inferred from an arktype schema so the server can validate
 * `run.json` on load and the UI can validate API responses with the same rules.
 */
import { type } from "arktype";

export const RunStatusSchema = type("'running' | 'complete' | 'failed' | 'cancelled'");
export type RunStatus = typeof RunStatusSchema.infer;

export const ReviewTargetSchema = type({
  kind: "'pr'",
  number: "number",
  url: "string",
  title: "string",
  author: "string",
  baseRef: "string",
  headRef: "string",
  state: "string",
  isDraft: "boolean",
})
  .or({ kind: "'range' | 'branch' | 'commit'", spec: "string" })
  .or({ kind: "'staged' | 'worktree'", "branch?": "string" });
export type ReviewTarget = typeof ReviewTargetSchema.infer;

export const DiffSideSchema = type("'additions' | 'deletions'");
export type DiffSide = typeof DiffSideSchema.infer;

export const AnchorReasonSchema = type(
  "'not-in-diff' | 'far-from-diff' | 'no-line' | 'deleted-file' | 'no-hunks'",
);
export type AnchorReason = typeof AnchorReasonSchema.infer;

/**
 * Where a finding or walkthrough stop lands in the diff.
 *
 * - `line`: the cited line is visible in a hunk.
 * - `nearby`: the cited line is outside every hunk but close to one; `line` is
 *   the nearest visible line and `cited` keeps what the model wrote.
 * - `file`: no usable line; `line` is 0 and `reason` says why.
 *
 * `text` is the patch text of `line` without its newline, set for `line` and `nearby`.
 */
export const DiffAnchorSchema = type({
  file: "string",
  side: DiffSideSchema,
  kind: "'line' | 'nearby' | 'file'",
  line: "number",
  "endLine?": "number",
  cited: { line: "number", "endLine?": "number" },
  "text?": "string",
  "reason?": AnchorReasonSchema,
});
export type DiffAnchor = typeof DiffAnchorSchema.infer;

export const RunFileStatusSchema = type("'added' | 'removed' | 'modified' | 'renamed' | 'copied'");
export type RunFileStatus = typeof RunFileStatusSchema.infer;

/**
 * Where a file runs, from `classifySurface` with the repo's settings applied.
 * Optional because runs written before it existed lack it.
 */
export const SurfaceSchema = type("'product' | 'deploy' | 'tooling'");

/** `blob` is the blob id on the head side; all zeros for a removed file. */
export const RunFileSchema = type({
  path: "string",
  "previousPath?": "string",
  status: RunFileStatusSchema,
  additions: "number",
  deletions: "number",
  isBinary: "boolean",
  "blob?": "string",
  groupId: "string",
  classification: "'code' | 'docs' | 'skip'",
  "surface?": SurfaceSchema,
});
export type RunFile = typeof RunFileSchema.infer;

export const GroupIconSchema = type("'bug' | 'wrench' | 'path' | 'flask' | 'doc' | 'gear'");
export type GroupIcon = typeof GroupIconSchema.infer;

/**
 * `parentId` is set on leaf groups that sit under a walkthrough chapter or a
 * trailing section. `files` lists files directly in this group; parent groups
 * list none of their own.
 */
export const RunGroupSchema = type({
  id: "string",
  "parentId?": "string",
  title: "string",
  "summary?": "string",
  "icon?": GroupIconSchema,
  files: "string[]",
  findingIds: "string[]",
  stopIds: "string[]",
  critical: "boolean",
});
export type RunGroup = typeof RunGroupSchema.infer;

/** `id` is `c<chapter>-s<stop>`, both 1-based. */
export const GuideStopSchema = type({
  id: "string",
  chapterId: "string",
  index: "number",
  title: "string",
  "prose?": "string",
  importance: "'critical' | 'normal' | 'context'",
  locations: DiffAnchorSchema.and({ "label?": "string" }).array(),
});
export type GuideStop = typeof GuideStopSchema.infer;

export const FindingSeveritySchema = type("'blocker' | 'should-fix' | 'nice-to-have' | 'question'");
export type FindingSeverity = typeof FindingSeveritySchema.infer;

/**
 * - `id`: fingerprint of file and title, the same id the GitHub markers use.
 * - `repeatOf`: id of a human's earlier comment making the same claim.
 * - `carriedFrom`: set when an earlier run of the same target reported this
 *   finding: the id of the run that first did.
 */
export const RunFindingSchema = type({
  id: "string",
  file: "string",
  anchor: DiffAnchorSchema,
  severity: FindingSeveritySchema,
  category: "string",
  title: "string",
  explanation: "string",
  evidence: "string",
  "impact?": "string",
  confidence: "'high' | 'medium' | 'low'",
  "effort?": "'quick' | 'moderate' | 'involved'",
  "suggestion?": "string",
  "suggestedCode?": "string",
  "crossFileRefs?": type({ file: "string", "line?": "number" }).array(),
  "repeatOf?": "number",
  "carriedFrom?": "string",
  "surface?": SurfaceSchema,
});
export type RunFinding = typeof RunFindingSchema.infer;

export const RunSliceSchema = type({
  unit: "string",
  part: "number",
  parts: "number",
  status: "'ok' | 'failed'",
  costUsd: "number",
  wallMs: "number",
});
export type RunSlice = typeof RunSliceSchema.infer;

export const RunRepoSchema = type({ root: "string", "slug?": "string" });

/**
 * - `groups`: parents come before their children; display order is array order.
 * - `overCapFindings`: findings the review stands behind but cut by the posting cap.
 * - `resolved`: findings from the prior run that this review found fixed.
 * - `unreviewed`: code files no reviewer read: over the slice cap, in a failed
 *   slice, or skipped at the cost limit.
 * - `meta.budgetStopped`: the cost limit stopped new slices from starting.
 * - `untrackedSkipped`: untracked files left out of a working-tree snapshot
 *   because of their size.
 */
export const ReviewRunSchema = type({
  schemaVersion: "1",
  id: "string",
  status: RunStatusSchema,
  createdAt: "string",
  repo: RunRepoSchema,
  target: ReviewTargetSchema,
  base: "string",
  head: "string",
  intent: {
    "stated?": "string",
    "inferred?": "string",
    "alignment?": "'aligned' | 'partial' | 'misaligned'",
    "matches?": "string[]",
    "mismatches?": "string[]",
    "unstated?": "string[]",
    "missing?": "string[]",
  },
  overview: {
    "focus?": "string",
    "changeType?": "string",
    startHere: type({ file: "string", why: "string" }).array(),
  },
  files: RunFileSchema.array(),
  groups: RunGroupSchema.array(),
  stops: GuideStopSchema.array(),
  findings: RunFindingSchema.array(),
  overCapFindings: RunFindingSchema.array(),
  resolved: type({ id: "string", "note?": "string", "title?": "string", "file?": "string" }).array(),
  unreviewed: { overCap: "string[]", failed: "string[]", "budget?": "string[]" },
  meta: {
    "model?": "string",
    "effort?": "string",
    wallMs: "number",
    costUsd: "number",
    slices: RunSliceSchema.array(),
    rejectedCount: "number",
    coreSource: "string",
    "mergeMode?": "'coordinator' | 'nothing-to-merge' | 'deterministic-fallback'",
    "budgetStopped?": "boolean",
  },
  untrackedSkipped: "string[]",
  "priorRunId?": "string",
  "error?": "string",
});
export type ReviewRun = typeof ReviewRunSchema.infer;

/** Reviewer state kept beside a run. Phase 2 only creates it empty. */
export const RunUserStateSchema = type({
  reviewedFiles: "string[]",
  findingStatus: type.Record("string", "'open' | 'accepted' | 'dismissed'"),
  comments: type({
    id: "string",
    file: "string",
    side: DiffSideSchema,
    line: "number",
    "endLine?": "number",
    body: "string",
  }).array(),
  "submitted?": { at: "string", "url?": "string" },
});
export type RunUserState = typeof RunUserStateSchema.infer;

/**
 * The fields `listRuns` reads from each `run.json`. `invalid` is set when the
 * file failed `ReviewRunSchema`; it holds the validation summary.
 */
export const RunHeaderSchema = type({
  id: "string",
  status: RunStatusSchema,
  createdAt: "string",
  target: ReviewTargetSchema,
  repo: RunRepoSchema,
  findingCounts: {
    blocker: "number",
    "should-fix": "number",
    "nice-to-have": "number",
    question: "number",
  },
  costUsd: "number",
  "invalid?": "string",
});
export type RunHeader = typeof RunHeaderSchema.infer;
