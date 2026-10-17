import { type Finding } from "./findings.ts";
import { type PriorComment } from "./context.ts";
import { classifySurface, SURFACE_RANK, SEV } from "./surface.ts";

/**
 * Every claim the bot has already made in a comment of its own, by fingerprint.
 *
 * The prompt asks the coordinator not to repeat a comment the bot has already
 * posted, and the prompt is the wrong mechanism for an invariant: the old bot
 * was asked the same thing and 40-50% of its output was restatement. This
 * compares what was actually posted against what is about to be, and does not
 * depend on the model having read or believed anything.
 *
 * Inline comments only, and the asymmetry is the whole point. An inline comment
 * is written once and stays on the pull request forever, so dropping the finding
 * from this run's output removes nothing a reader can see. The summary is the
 * opposite: it is rewritten from scratch on every push, so a finding routed out
 * of the inline set lives in that one body and nowhere else. Suppressing it
 * deletes it from the summary, its `summary-item` marker goes with it, and the
 * run after that no longer sees the claim and reports it again — the finding
 * flickers on alternate pushes rather than either persisting or staying quiet.
 *
 * So a demoted finding is re-rendered every run, on purpose. That is not
 * restatement: the summary comment is edited in place, so re-stating a claim
 * inside it notifies nobody and is what keeps the list an accurate picture of
 * what is still open. The cost is that those findings keep occupying slots under
 * the cap, which is the right trade against silently losing them.
 */
export function saidFingerprints(prior: PriorComment[]): Map<string, PriorComment> {
  return new Map<string, PriorComment>(
    prior.filter((c) => c.mine && c.fingerprint && !c.addressed).map((c) => [c.fingerprint!, c]),
  );
}

/**
 * What the coordinator gets to spend, in dollars.
 *
 * Verification cost scales with how many findings there are to verify, so a flat
 * cap is a cap on the wrong quantity. When it bound, the coordinator was cut off
 * mid-pass and everything it had already cleared went with it — one measured run
 * spent sixteen dollars on slices and returned no findings at all. The ceiling
 * is there because the alternative failure is an unbounded bill.
 */
export const MAX_CHECKED_PER_SLICE = 4;
export const MAX_CHECKED_CHARS = 300;

/**
 * The `checked` claims from a slice's findings file: what the reviewer verified
 * and found correct. Strings only, trimmed, capped in count and length, since
 * the file is model output and the claims go into the posted comment.
 */
export function readCheckedClaims(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  const checked = (payload as { checked?: unknown }).checked;
  if (!Array.isArray(checked)) return [];
  return checked
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_CHECKED_PER_SLICE)
    .map((c) => (c.length > MAX_CHECKED_CHARS ? `${c.slice(0, MAX_CHECKED_CHARS - 1)}…` : c));
}

export function mergeBudgetFor(findingCount: number, floor: number): number {
  return Math.min(9, Math.max(floor, 0.22 * findingCount));
}

/**
 * Orders raw findings for the path taken when the coordinator never answered.
 *
 * Nothing here has been verified — that was the coordinator's job, and on this
 * path it is what failed. So the ordering does the only filtering available.
 * Findings are deduplicated by location, because several slices reviewing
 * neighbouring files routinely report the same problem and the coordinator is
 * what normally merges those. A nice-to-have is dropped unless the reviewer was
 * confident, since an unverified low-confidence suggestion is the least likely
 * thing in the set to be real and the most likely to read as noise.
 *
 * Confidence is deliberately not part of the sort, unlike the verified path.
 * There it ranks findings a coordinator has already stood behind; here it is the
 * reviewer's own unchecked estimate of itself, which is not a reason to put one
 * finding above another.
 */
export function fallbackRank(raw: Finding[]): Finding[] {
  const seen = new Set<string>();
  return raw
    .filter((f) => {
      const key = `${f.file}:${f.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return f.severity !== "nice-to-have" || f.confidence === "high";
    })
    .sort(
      (a, b) =>
        (SEV[a.severity]?.rank ?? 9) - (SEV[b.severity]?.rank ?? 9) ||
        SURFACE_RANK[classifySurface(a.file)] - SURFACE_RANK[classifySurface(b.file)],
    );
}

/**
 * Whether the coordinator has anything to decide. It rules on raw findings and
 * closes out the bot's own earlier review comments as fixed. With neither, the
 * call only produces an intent summary, and one such run spent $0.57 over 38
 * turns looking for something to verify.
 */
export function coordinatorHasWork(toMerge: Finding[], prior: PriorComment[]): boolean {
  return toMerge.length > 0 || prior.some((c) => c.mine && c.file && !c.addressed);
}

/** The coordinator's verdict on the numbered raw findings it was handed. */
export interface MergeDecisions {
  keep?: {
    id: number;
    severity?: Finding["severity"];
    merge_with?: number[];
    repeat_of?: number;
    preexisting?: boolean;
    note?: string;
  }[];
  drop?: { id: number; reason: string }[];
  resolved?: { id: number; note?: string }[];
  intent_alignment?: { summary?: string; unstated?: string[]; missing?: string[] };
}

/**
 * Turns the coordinator's verdict back into findings.
 *
 * It returns decisions over numbered raw findings rather than rewritten ones:
 * the slice that found a problem already wrote it up well, and retyping every
 * finding cost 15k output tokens on the critical path for no gain. So the
 * finding that gets posted is the reviewer's text with the coordinator's
 * judgement laid over it — its severity, its note, and the sibling findings it
 * decided were the same problem.
 *
 * An id appears in at most one decision. Whichever decision reaches it first
 * claims it, so a finding cannot be both kept and dropped, and cannot be merged
 * into two different parents.
 */
/** New findings posted per review. The coordinator is told the same number. */
export const MAX_POSTED = 10;
/** New findings posted on a re-review that only looked at what changed since the last one. */
export const MAX_POSTED_INCREMENTAL = 5;
/** Findings about code the change did not touch, capped on their own so they cannot crowd out the change. */
export const MAX_PREEXISTING = 3;
/** "cap", or the phrasing the coordinator used before it was told the exact word. */
export const CAP_REASON = /^\s*(cut for the )?cap\b/i;

/**
 * Splits findings already sorted by importance into what is posted and what is
 * listed as over the cap. Corroborations (`repeat_of`) are uncapped, new
 * findings on the change get `maxNew` slots, and pre-existing findings get
 * their own `maxPreexisting`, so neither pool can push the other out.
 */
export function capFindings(
  sorted: Finding[],
  limits: { maxNew: number; maxPreexisting: number },
): { posted: Finding[]; overCap: Finding[] } {
  const posted: Finding[] = [];
  const overCap: Finding[] = [];
  const seen = { fresh: 0, preexisting: 0 };
  for (const f of sorted) {
    if (f.repeat_of) {
      posted.push(f);
      continue;
    }
    const pool = f.preexisting ? "preexisting" : "fresh";
    const limit = f.preexisting ? limits.maxPreexisting : limits.maxNew;
    (seen[pool] < limit ? posted : overCap).push(f);
    seen[pool] += 1;
  }
  return { posted, overCap };
}

export function applyDecisions(
  decisions: MergeDecisions,
  toMerge: Finding[],
  prior: PriorComment[],
): { kept: Finding[]; dropped: { title: string; reason: string }[]; capped: Finding[] } {
  const kept: Finding[] = [];
  const dropped: { title: string; reason: string }[] = [];
  const capped: Finding[] = [];
  const claimed = new Set<number>();
  const priorById = new Map(prior.map((c) => [c.id, c]));
  for (const d of decisions.keep ?? []) {
    const base = toMerge[d.id];
    if (!base) continue;
    if (claimed.has(d.id)) continue;
    claimed.add(d.id);
    const refs = new Set(base.cross_file_refs ?? []);
    for (const m of d.merge_with ?? []) {
      const other = toMerge[m];
      if (!other || claimed.has(m)) continue;
      claimed.add(m);
      refs.add(`${other.file}:${other.line}`);
      for (const r of other.cross_file_refs ?? []) refs.add(r);
    }
    // A `repeat_of` is only honored when it names a human's review comment.
    // Pointed at one of the bot's own, it would render as the bot replying to
    // itself in agreement; pointed at an id that is not on this PR at all, it
    // would silently move the finding out of the review and into nothing.
    // Pointed at a conversation comment, the reply endpoint is
    // `pulls/<pr>/comments/<id>/replies`, which only accepts review comment
    // ids, so the post step would 404 and the finding would be lost. Either
    // way the finding is real and belongs in the review on its own.
    const echo = d.repeat_of ? priorById.get(d.repeat_of) : undefined;
    const corroborates = echo && !echo.mine && echo.file ? d.repeat_of : undefined;
    if (d.repeat_of && !corroborates) {
      const why = !echo
        ? "no such comment on this PR"
        : echo.mine
          ? "the bot's own comment"
          : "not a review comment, so it has no thread to reply into";
      console.error(`  repeat_of ${d.repeat_of} on "${base.title}" ignored: ${why}`);
    }
    kept.push({
      ...base,
      severity: d.severity ?? base.severity,
      explanation: d.note ? `${base.explanation}\n\n${d.note}` : base.explanation,
      cross_file_refs: refs.size ? [...refs] : undefined,
      // Written unconditionally rather than spread in only when it vets, and
      // after `...base` rather than before. A slice reviewer is told to set
      // `repeat_of` as well — the human-comments section of the slice prompt
      // says to — so `base` can already carry one that never went through the
      // check above. Adding the key only on success would leave that value
      // untouched and the rejection logged above would do nothing.
      repeat_of: corroborates,
      preexisting: typeof d.preexisting === "boolean" ? d.preexisting : base.preexisting,
    } as Finding);
  }
  for (const d of decisions.drop ?? []) {
    const base = toMerge[d.id];
    if (base && !claimed.has(d.id)) {
      claimed.add(d.id);
      // Cut for space rather than rejected: still a finding, just not posted.
      if (CAP_REASON.test(d.reason ?? "")) capped.push({ ...base, repeat_of: undefined });
      else dropped.push({ title: base.title, reason: d.reason });
    }
  }
  // Silence is not a decision: anything the coordinator ignored is not posted,
  // and the run record says so rather than losing it.
  toMerge.forEach((f, i) => {
    if (!claimed.has(i)) {
      dropped.push({ title: f.title, reason: "coordinator did not rule on this finding" });
    }
  });
  return { kept, dropped, capped };
}
