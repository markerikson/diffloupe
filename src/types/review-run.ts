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
 * - `alsoAt`: other places the same defect occurs and needs the same fix.
 * - `repeatOf`: id of a human's earlier comment making the same claim.
 * - `carriedFrom`: set when an earlier run of the same target reported this
 *   finding: the id of the run that first did.
 * - `preexisting`: the problem is in code the change did not add or modify.
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
  "alsoAt?": type({ file: "string", "line?": "number" }).array(),
  "repeatOf?": "number",
  "carriedFrom?": "string",
  "surface?": SurfaceSchema,
  "preexisting?": "boolean",
});
export type RunFinding = typeof RunFindingSchema.infer;

/**
 * Tokens one agent call used. `input` excludes cached tokens: the prompt is
 * `input + cacheRead + cacheWrite`. `firstStep` is the session's first request
 * alone, which shows whether the shared prompt prefix hit the prompt cache.
 */
export const RunUsageSchema = type({
  input: "number",
  output: "number",
  reasoning: "number",
  cacheRead: "number",
  cacheWrite: "number",
  "firstStep?": { input: "number", cacheRead: "number", cacheWrite: "number" },
});
export type RunUsage = typeof RunUsageSchema.infer;

export const RunSliceSchema = type({
  unit: "string",
  part: "number",
  parts: "number",
  status: "'ok' | 'failed'",
  costUsd: "number",
  wallMs: "number",
  "usage?": RunUsageSchema,
});
export type RunSlice = typeof RunSliceSchema.infer;

/** Cost, time and tokens of a single-call stage. */
export const RunStageCostSchema = type({ costUsd: "number", wallMs: "number", "usage?": RunUsageSchema });
export type RunStageCost = typeof RunStageCostSchema.infer;

/** `remote`: `root` is DiffLoupe's partial copy of the GitHub repository, not the user's clone. */
export const RunRepoSchema = type({ root: "string", "slug?": "string", "remote?": "boolean" });

export const RunKindSchema = type("'review' | 'diff'");
export type RunKind = typeof RunKindSchema.infer;

/** A run's kind; runs written before diff runs existed have none and are reviews. */
export function runKind(run: { meta: { kind?: RunKind | undefined } }): RunKind {
  return run.meta.kind ?? "review";
}

/**
 * Per prior finding: whether the code at its lines changed before this run
 * (`acted`), and whether the same span 35 lines away did (`control`).
 */
export const PriorActedOnSchema = type({ id: "string", acted: "boolean", control: "boolean" });
export type PriorActedOn = typeof PriorActedOnSchema.infer;

/**
 * - `groups`: parents come before their children; display order is array order.
 * - `overCapFindings`: findings the review stands behind but cut by the posting cap.
 * - `resolved`: findings from the prior run that this review found fixed.
 * - `unreviewed`: code files no reviewer read: over the slice cap, in a failed
 *   slice, or skipped at the cost limit.
 * - `meta.budgetStopped`: the cost limit stopped new slices from starting.
 * - `meta.reviewScope`: `incremental` when a re-review looked only at files
 *   changed since the prior run's head; `meta.reviewedFiles` counts the files
 *   the reviewers read, `meta.scopeReason` says why a re-review went full.
 * - `meta.promptVersion`, `meta.instructionsHash`: short hashes of the review
 *   prompts and the repo's review instructions, to compare runs across versions.
 * - `meta.slices[].usage`, `meta.stages`: tokens per agent call, when recorded.
 * - `round`: 1 for a first review, one more than the prior run's otherwise.
 * - `priorActedOn`: set when the prior run reviewed a different head; one
 *   entry per prior finding anchored to a line on the additions side.
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
    /**
     * The model each stage ran, as `provider/model[#variant]`, and where the
     * choice came from. A diff run lists only the walkthrough, when it ran one.
     */
    "models?": {
      "review?": { model: "string", "source?": "string" },
      "coordinator?": { model: "string", "source?": "string" },
      "walkthrough?": { model: "string", "source?": "string" },
      "intent?": { model: "string", "source?": "string" },
    },
    /** `diff`: grouped diff with no review agents. Missing means `review`. */
    "kind?": RunKindSchema,
    wallMs: "number",
    costUsd: "number",
    slices: RunSliceSchema.array(),
    /** The single-call stages; a stage that did not run is absent. */
    "stages?": {
      "coordinator?": RunStageCostSchema,
      "walkthrough?": RunStageCostSchema,
      "intent?": RunStageCostSchema,
    },
    rejectedCount: "number",
    coreSource: "string",
    "mergeMode?": "'coordinator' | 'nothing-to-merge' | 'deterministic-fallback'",
    "budgetStopped?": "boolean",
    "reviewScope?": "'full' | 'incremental'",
    "reviewedFiles?": "number",
    "scopeReason?": "string",
    "promptVersion?": "string",
    "instructionsHash?": "string",
  },
  untrackedSkipped: "string[]",
  "priorRunId?": "string",
  "round?": "number",
  "priorActedOn?": PriorActedOnSchema.array(),
  "error?": "string",
});
export type ReviewRun = typeof ReviewRunSchema.infer;

export const FindingStatusSchema = type("'open' | 'accepted' | 'dismissed'");
export type FindingStatus = typeof FindingStatusSchema.infer;

export const DismissReasonSchema = type("'wrong' | 'not-worth-fixing' | 'already-handled' | 'duplicate' | 'other'");
export type DismissReason = typeof DismissReasonSchema.infer;
export const DISMISS_REASONS: readonly DismissReason[] = [
  "wrong",
  "not-worth-fixing",
  "already-handled",
  "duplicate",
  "other",
];

export const FindingNoteSchema = type({ reason: DismissReasonSchema, "note?": "string", at: "string" });
export type FindingNote = typeof FindingNoteSchema.infer;

/**
 * Reviewer state kept beside a run in `state.json`.
 *
 * - `reviewedFiles`: path to the head blob id when the file was marked
 *   reviewed, `''` for a removed file.
 * - `findingStatus`: a finding with no entry is open.
 * - `findingNotes`: why a dismissed finding was dismissed.
 */
export const RunUserStateSchema = type({
  reviewedFiles: type.Record("string", "string"),
  findingStatus: type.Record("string", FindingStatusSchema),
  "findingNotes?": type.Record("string", FindingNoteSchema),
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
  "kind?": RunKindSchema,
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
