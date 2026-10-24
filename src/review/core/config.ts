import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Directory holding the core's own assets (system.md, opencode/). In the
 * bundled build every module's `import.meta.dir` is `dist/`, and the build
 * copies the assets to `dist/review-core/`.
 */
export const DIR = existsSync(path.join(import.meta.dir, "system.md"))
  ? import.meta.dir
  : path.join(import.meta.dir, "review-core");
/**
 * The checkout of the code being reviewed, at the PR head. Assigned in runReview().
 *
 * This is deliberately a different directory from the home clone: a review must not
 * move the checkout it is running out of, or the reviewer's own scripts change
 * underneath it mid-run and a developer's branch position is lost.
 */
export let SUBJECT = process.cwd();
export let releaseSubject: () => Promise<void> = async () => {};
/** Where run records, prompts and rendered reviews land. Kept outside DIR. */
export let ARTIFACTS = process.env.CODE_REVIEW_ARTIFACTS ?? path.join(process.cwd(), ".code-review");
export const RUNNER = "opencode";
/**
 * Provider prefix applied to a bare model name under the OpenCode runner, which
 * addresses models as `provider/model`. A name that already carries a slash is
 * passed through untouched.
 */
export let PROVIDER = process.env.REVIEW_PROVIDER ?? "anthropic";
/**
 * Backstop on agentic iterations under the OpenCode runner, which has no notion
 * of a spend cap of its own. Cost is what actually bounds a slice — see the
 * governor plugin — and this only catches an agent that has been refused every
 * tool and keeps calling them anyway. Set well clear of the ~37 turns the
 * largest observed slice used, so that it never binds in normal operation.
 */
export let MAX_STEPS = envNumber("REVIEW_MAX_STEPS", 80);
/**
 * Wall-clock ceiling on a single OpenCode call, in seconds.
 *
 * The spend cap is not a time bound, and on a cheap model the two come apart:
 * one measured GLM-5.3-Flash slice reached thirteen minutes having spent $0.10
 * of a $3 budget, so every cost stage in the governor stayed inert while the
 * run went on. Slices run concurrently, so this is close to the ceiling on the
 * whole review rather than a per-slice tax on it.
 *
 * Set clear of the 569s of the slowest healthy Opus slice, so it is a backstop
 * against a runaway rather than a routine constraint. Lower it per run to hold
 * a model to a tighter budget of time.
 */
export let DEADLINE_MS = envNumber("REVIEW_DEADLINE_S", 900) * 1000;
export let MODEL = process.env.REVIEW_MODEL ?? "claude-opus-5-5";
/**
 * Output token generation is what the wall clock measures — a slice writes 13-16k
 * tokens and spends most of its time doing it. Effort is the direct control over
 * how much of that is thinking.
 */
export let EFFORT = process.env.REVIEW_EFFORT ?? "medium";
/** Orientation and intent are summarization, not deep reasoning: cheaper tier. */
export let MODEL_WALK = process.env.REVIEW_MODEL_WALK ?? "claude-sonnet-5-5";
/**
 * The coordinator judges findings it did not produce: it deduplicates across
 * slices, rejects what the evidence does not support, and applies the cap. That
 * is a different job from finding a defect, and the two are not necessarily best
 * served by the same model — a reviewer wants recall, a coordinator wants
 * precision.
 *
 * Defaults to MODEL, so a run that sets only REVIEW_MODEL still moves both and
 * nothing changes for a caller that does not know this exists. Setting it is
 * also what makes a model comparison attributable: without it, swapping the
 * slice model swaps the judge of that model's output at the same time.
 */
export let MODEL_MERGE = process.env.REVIEW_MODEL_MERGE ?? MODEL;
/**
 * Drafts the change's intent from the whole diff before the slices start, so a
 * reviewer that sees one part knows what the rest is for. A summary of text
 * already in the prompt: the smallest tier does it.
 */
export let MODEL_INTENT = process.env.REVIEW_MODEL_INTENT ?? "claude-haiku-5-5";
/**
 * Effort for the three calls that are not the review itself: planning the
 * units, writing the walkthrough, and consolidating findings.
 *
 * Separate from EFFORT because thinking is what the wall clock and the bill
 * both measure, and these three have never produced a finding — on one measured
 * run they were $0.61 of $2.19. Defaults to EFFORT so the split is something a
 * run opts into rather than inherits.
 *
 * Consolidation is the one to watch. On a single-slice review it passes findings
 * through nearly untouched, but its real work is deduplicating across slices and
 * applying the finding cap, and that is judgement. Lowering it is only clearly
 * safe for the other two.
 */
export let EFFORT_AUX = process.env.REVIEW_EFFORT_AUX ?? EFFORT;
/** A positive number from the environment, or `fallback` when unset or blank. */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${process.env[name]}"`);
  }
  return value;
}
export let WALK_BUDGET = envNumber("WALK_BUDGET_USD", 2);
export let PART_BUDGET = envNumber("PART_BUDGET", 0.6);
export let INTENT_BUDGET = envNumber("INTENT_BUDGET_USD", 0.1);
/**
 * How changed files become review units. `code` computes the groups from links
 * in the diff (`lib/grouping.ts`) and asks the aux model only to name them and,
 * optionally, move a file; `model` asks the aux model to partition from the
 * hunk outline. The model partition split the one cross-file defect in #13157
 * across two reviewers; the computed grouping keeps that pair together.
 */
export let GROUPING = process.env.REVIEW_GROUPING ?? "code";
if (GROUPING !== "code" && GROUPING !== "model") {
  throw new Error(`REVIEW_GROUPING must be "code" or "model", got "${GROUPING}"`);
}
export let SLICE_BUDGET = envNumber("SLICE_BUDGET_USD", 3);
export let MERGE_BUDGET = envNumber("MERGE_BUDGET_USD", 3);
export let POOL = envNumber("SLICE_POOL", 6);
/**
 * Cap on review slices, and so on cost: the run cannot spend more than this
 * times `SLICE_BUDGET` on reviewing. Slices are packed to `MAX_SLICE_TOKENS`,
 * so this also caps how much diff gets read — 16 slices covers a pull request
 * of roughly 650k diff tokens, which is past the 99th percentile here.
 */
export let MAX_SLICES = envNumber("MAX_SLICES", 16);
/**
 * Characters per model token in a diff, for sizing slices before any model
 * sees them. Measured on the first-turn prompts of #13157 with Opus 5.5 and
 * Sonnet 5.5: 2.15 to 2.51 across 16 slices. The usual 4 undercounts code by
 * about 1.7x.
 */
export const CHARS_PER_TOKEN = 2.4;
/**
 * Diff tokens one reviewer is given.
 *
 * Measured rather than guessed. A slice re-reads its diff on every turn, so
 * input size is a tax on every turn: at 138k tokens of input, 72% of each
 * turn's cost was input-proportional, against 29% at 22k. The budget then buys
 * fewer turns exactly when there is more to look at, and yield collapses —
 * across six units of one pull request, findings per 1k input tokens fell from
 * 1.05 at 5k input to 0.014 at 138k, and the two largest units both ran out of
 * budget without finishing.
 *
 * The default buys roughly 31 turns at a $3 slice budget, which is where every
 * unit that finished was operating. Splitting one 138k-token unit into two of
 * this size took it from 2 findings and none surviving verification to 7 and
 * 6. Those measurements sized slices at 4 characters per token; 42k at
 * CHARS_PER_TOKEN is the same amount of diff.
 */
export let MAX_SLICE_TOKENS = envNumber("MAX_SLICE_TOKENS", 42000);
/**
 * Diff tokens the walkthrough is given.
 *
 * It is bounded separately, and more tightly than the sum of the slices,
 * because it fails differently: a slice that runs short still emits the
 * findings it has, while the walkthrough writes one JSON object at the end and
 * so yields nothing at all. On a 33k-line pull request it was handed a diff cut
 * at a byte offset, spent its whole budget, wrote no file, and the run reported
 * "0 stops" as though it had read everything and found nothing worth pointing
 * at. Whole files up to this budget, with the rest disclosed to it as sketches.
 */
export let WALK_DIFF_TOKENS = envNumber("WALK_DIFF_TOKENS", 100000);
/**
 * Whether findings also get inline comments on their lines, or live only in
 * the summary. "tier" posts an inline comment for each finding on the change's
 * most production-proximate surface; "none" posts the summary alone. Summary-only
 * is the default: the summary is edited in place, so a re-review notifies once
 * instead of once per finding, and every finding is in it with a permalink and
 * evidence either way. Inline mode exists because line-anchored comments are
 * how human reviewers work here — flip it per-repo, not per-run.
 */
export const INLINE_MODE: "tier" | "none" = process.env.INLINE_MODE === "tier" ? "tier" : "none";
/**
 * Scratch directory the agent writes its findings JSON into. It sits outside the
 * checkout so that writing findings does not dirty the tree under review.
 *
 * This is where the findings are meant to go, not a boundary that stops them
 * going elsewhere: see the tool restrictions on the agent() call.
 */
export let OUT = process.env.CODE_REVIEW_SCRATCH ?? path.join(os.tmpdir(), "code-review-out");
/** owner/name, interpolated into prompt prose. Assigned once, in main(). */
export let repoName = "this repository";

/**
 * Path patterns that override `classifySurface`'s generic rules. Each entry is
 * a regular expression source matched against the repo-relative path.
 */
export interface SurfacePatterns {
  deploy: string[];
  tooling: string[];
}

export let SURFACES: SurfacePatterns = {
  deploy: [],
  tooling: ["^docs/", "(^|/)[^/]*\\.config\\.[cm]?[jt]s$"],
};

/** Repo-specific additions to the map builder's and registry check's EXCLUDE lists. */
export let EXTRA_EXCLUDES: string[] = [];

/**
 * Lowest severity the summary lists with the main findings and inline comments
 * can carry. Findings below it go in a collapsed "Minor findings" section and
 * are not counted as posted in `result.json`. Null lists every severity.
 */
export let POST_MIN_SEVERITY: PostSeverity | null = null;
export type PostSeverity = "blocker" | "should-fix" | "nice-to-have" | "question";
/** Leaves questions out of the posted review entirely. They stay in the run record. */
export let DROP_QUESTIONS = false;

/** The `providers` block written into the generated OpenCode config. Empty writes none. */
export let PROVIDERS: Record<string, unknown> = {};
/** Extra environment for every OpenCode child: provider keys that must not reach this process's env. */
export let CHILD_ENV: Record<string, string> = {};
/**
 * `opencode auth import` input for every call's data directory, as JSON. Empty
 * imports nothing. Holds API keys, so it is never written anywhere but stdin.
 */
export let AUTH_IMPORT = "";

export interface ReviewConfig {
  provider: string;
  model: string;
  modelMerge: string;
  modelWalk: string;
  modelIntent: string;
  effort: string;
  effortAux: string;
  sliceBudget: number;
  mergeBudget: number;
  walkBudget: number;
  partBudget: number;
  intentBudget: number;
  pool: number;
  maxSlices: number;
  maxSliceTokens: number;
  walkDiffTokens: number;
  maxSteps: number;
  deadlineMs: number;
  grouping: "code" | "model";
  artifacts: string;
  out: string;
  extraExcludes: string[];
  surfaces: SurfacePatterns;
  postMinSeverity: PostSeverity | null;
  dropQuestions: boolean;
  providers: Record<string, unknown>;
  childEnv: Record<string, string>;
  authImport: string;
}

/**
 * Override settings for the next run. ESM imports are live bindings, so every
 * module that imports these names sees the new values.
 *
 * `modelMerge` follows `model` and `effortAux` follows `effort` when only the
 * latter is given and the matching environment variable is unset, the same
 * defaulting the env reads above do.
 */
export function applyConfig(o: Partial<ReviewConfig>): void {
  if (o.provider !== undefined) PROVIDER = o.provider;
  if (o.model !== undefined) {
    MODEL = o.model;
    if (o.modelMerge === undefined && process.env.REVIEW_MODEL_MERGE === undefined) MODEL_MERGE = o.model;
  }
  if (o.modelMerge !== undefined) MODEL_MERGE = o.modelMerge;
  if (o.modelWalk !== undefined) MODEL_WALK = o.modelWalk;
  if (o.modelIntent !== undefined) MODEL_INTENT = o.modelIntent;
  if (o.effort !== undefined) {
    EFFORT = o.effort;
    if (o.effortAux === undefined && process.env.REVIEW_EFFORT_AUX === undefined) EFFORT_AUX = o.effort;
  }
  if (o.effortAux !== undefined) EFFORT_AUX = o.effortAux;
  if (o.sliceBudget !== undefined) SLICE_BUDGET = o.sliceBudget;
  if (o.mergeBudget !== undefined) MERGE_BUDGET = o.mergeBudget;
  if (o.walkBudget !== undefined) WALK_BUDGET = o.walkBudget;
  if (o.partBudget !== undefined) PART_BUDGET = o.partBudget;
  if (o.intentBudget !== undefined) INTENT_BUDGET = o.intentBudget;
  if (o.pool !== undefined) POOL = o.pool;
  if (o.maxSlices !== undefined) MAX_SLICES = o.maxSlices;
  if (o.maxSliceTokens !== undefined) MAX_SLICE_TOKENS = o.maxSliceTokens;
  if (o.walkDiffTokens !== undefined) WALK_DIFF_TOKENS = o.walkDiffTokens;
  if (o.maxSteps !== undefined) MAX_STEPS = o.maxSteps;
  if (o.deadlineMs !== undefined) DEADLINE_MS = o.deadlineMs;
  if (o.grouping !== undefined) GROUPING = o.grouping;
  if (o.artifacts !== undefined) ARTIFACTS = o.artifacts;
  if (o.out !== undefined) OUT = o.out;
  if (o.extraExcludes !== undefined) EXTRA_EXCLUDES = o.extraExcludes;
  if (o.surfaces !== undefined) SURFACES = o.surfaces;
  if (o.postMinSeverity !== undefined) POST_MIN_SEVERITY = o.postMinSeverity;
  if (o.dropQuestions !== undefined) DROP_QUESTIONS = o.dropQuestions;
  if (o.providers !== undefined) PROVIDERS = o.providers;
  if (o.childEnv !== undefined) CHILD_ENV = o.childEnv;
  if (o.authImport !== undefined) AUTH_IMPORT = o.authImport;
}

/** Aborted when the run is cancelled. Assigned by runReview(). */
export let SIGNAL: AbortSignal | undefined;

/** Per-run state, assigned by runReview(). Only one run per process. */
export function setRunState(s: {
  subject?: string;
  releaseSubject?: () => Promise<void>;
  repoName?: string;
  signal?: AbortSignal;
}): void {
  if (s.subject !== undefined) SUBJECT = s.subject;
  if (s.releaseSubject !== undefined) releaseSubject = s.releaseSubject;
  if (s.repoName !== undefined) repoName = s.repoName;
  if (s.signal !== undefined) SIGNAL = s.signal;
}

export function resetRunState(): void {
  SUBJECT = process.cwd();
  releaseSubject = async () => {};
  repoName = "this repository";
  SIGNAL = undefined;
}
