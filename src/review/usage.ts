/**
 * Token usage in `run.json`, converted from the review core's per-call
 * accounting, and the totals `runs show` and `runs stats` print.
 */
import type { ReviewRun, RunStageCost, RunUsage } from "../types/review-run.ts";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The core's `{ input_tokens, ..., first_step? }` as a `RunUsage`, or undefined when absent. */
export function toRunUsage(raw: unknown): RunUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  if (typeof u.input_tokens !== "number" && typeof u.output_tokens !== "number") return undefined;
  const first = u.first_step as Record<string, unknown> | undefined;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    reasoning: num(u.reasoning_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    ...(typeof first === "object" && first !== null
      ? {
          firstStep: {
            input: num(first.input_tokens),
            cacheRead: num(first.cache_read_input_tokens),
            cacheWrite: num(first.cache_creation_input_tokens),
          },
        }
      : {}),
  };
}

/** A stage that ran: it cost something or reported tokens. Undefined otherwise. */
export function toStageCost(raw: unknown): RunStageCost | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const s = raw as Record<string, unknown>;
  if (s.cached === true) return undefined;
  const usage = toRunUsage(s.usage);
  const costUsd = num(s.costUsd);
  if (!usage && costUsd === 0) return undefined;
  return { costUsd, wallMs: num(s.wallMs), ...(usage ? { usage } : {}) };
}

/** `meta.stages` from the core's run record. */
export function stagesFromRecord(record: Record<string, unknown> | null | undefined): ReviewRun["meta"]["stages"] {
  const coordinator = toStageCost(record?.merge);
  const walkthrough = toStageCost(record?.walk);
  const intent = toStageCost(record?.intentDraft);
  if (!coordinator && !walkthrough && !intent) return undefined;
  return {
    ...(coordinator ? { coordinator } : {}),
    ...(walkthrough ? { walkthrough } : {}),
    ...(intent ? { intent } : {}),
  };
}

/**
 * Fills slice and stage usage from the saved core record, for runs written
 * before `run.json` carried tokens. Slices line up with `record.sliceRuns` by
 * position, since `buildReviewRun` maps them in order.
 */
export function withRecordUsage(run: ReviewRun, record: unknown): ReviewRun {
  if (typeof record !== "object" || record === null) return run;
  const rec = record as Record<string, unknown>;
  const sliceRuns = Array.isArray(rec.sliceRuns) ? (rec.sliceRuns as Record<string, unknown>[]) : [];
  const slices = run.meta.slices.map((s, i) => {
    if (s.usage) return s;
    const raw = sliceRuns[i];
    if (!raw || raw.unit !== s.unit || raw.part !== s.part) return s;
    const usage = toRunUsage(raw.usage);
    return usage ? { ...s, usage } : s;
  });
  const stages = run.meta.stages ?? stagesFromRecord(rec);
  return { ...run, meta: { ...run.meta, slices, ...(stages ? { stages } : {}) } };
}

export function hasUsage(run: ReviewRun): boolean {
  return run.meta.slices.some((s) => s.usage) || Object.values(run.meta.stages ?? {}).some((s) => s?.usage);
}

export interface UsageTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** Agent calls with recorded usage. */
  calls: number;
  /** Cache read share of each slice's first request, for slices that recorded one. */
  firstStepShares: number[];
}

export const emptyUsageTotals = (): UsageTotals => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  calls: 0,
  firstStepShares: [],
});

/** Share of prompt tokens read from the cache, or null with no prompt tokens. */
export function cacheShare(u: { input: number; cacheRead: number; cacheWrite: number }): number | null {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return prompt > 0 ? u.cacheRead / prompt : null;
}

function add(into: UsageTotals, u: RunUsage): void {
  into.input += u.input;
  into.output += u.output;
  into.reasoning += u.reasoning;
  into.cacheRead += u.cacheRead;
  into.cacheWrite += u.cacheWrite;
  into.calls++;
}

/**
 * Every recorded call of a run summed. First-request shares come from slices
 * only: they share the system prompt and the run's context, so they are the
 * calls a common prompt prefix could serve from the cache.
 */
export function runUsageTotals(run: ReviewRun, into: UsageTotals = emptyUsageTotals()): UsageTotals {
  for (const s of run.meta.slices) {
    if (!s.usage) continue;
    add(into, s.usage);
    const share = s.usage.firstStep ? cacheShare(s.usage.firstStep) : null;
    if (share !== null) into.firstStepShares.push(share);
  }
  for (const stage of Object.values(run.meta.stages ?? {})) if (stage?.usage) add(into, stage.usage);
  return into;
}

export function median(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return null;
  return sorted.length % 2 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** "1.2M prompt (84% from cache), 40K output, 12K reasoning; first requests 62% from cache (median of 8)", or undefined with no data. */
export function formatUsage(t: UsageTotals): string | undefined {
  if (!t.calls) return undefined;
  const share = cacheShare(t);
  const first = median(t.firstStepShares);
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  return (
    `${tokens(prompt)} prompt${share === null ? "" : ` (${pct(share)} from cache)`}, ${tokens(t.output)} output` +
    (t.reasoning ? `, ${tokens(t.reasoning)} reasoning` : "") +
    (first === null ? "" : `; first requests ${pct(first)} from cache (median of ${t.firstStepShares.length})`)
  );
}
