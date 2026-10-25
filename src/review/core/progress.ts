/**
 * Where the bot's earlier findings on a pull request stand after a review, so
 * a CI job can tell whether rounds are converging.
 */
import type { PriorComment, PriorRuling } from "./context.ts";
import type { DisputeRuling } from "./disputes.ts";

export interface RoundProgress {
  /** Earlier findings still open after this review, upheld disputes included. */
  open: number;
  /** Earlier findings closed out as fixed, by this review or an earlier one. */
  fixed: number;
  /** Findings withdrawn after a dispute, by this review or an earlier one. */
  withdrawn: number;
  /** Findings whose dispute was upheld and is left for a human reviewer. */
  upheld: number;
  /** Earlier findings this review closed out as fixed. */
  fixedThisRound: number;
  /** Findings this review withdrew after a dispute. */
  withdrawnThisRound: number;
  /** Findings this review raised. Repeats of earlier findings are never raised again. */
  new: number;
}

/**
 * Counts earlier findings by the bot's own inline comments, one per
 * fingerprint. A finding that lives only in the summary comment has no thread
 * to close, so it is counted only when it is withdrawn.
 */
export function roundProgress(input: {
  prior: PriorComment[];
  resolvedIds: number[];
  earlierRulings: PriorRuling[];
  rulings: DisputeRuling[];
  newFindings: number;
}): RoundProgress {
  const { prior, earlierRulings, rulings } = input;
  const ruled = (outcome: PriorRuling["outcome"]) =>
    new Set([...earlierRulings, ...rulings].filter((r) => r.outcome === outcome).map((r) => r.fp));
  const withdrawn = ruled("withdrawn");
  const upheld = ruled("upheld");
  const resolvedNow = new Set(input.resolvedIds);

  const earlier = new Map<string, { addressed: boolean; resolvedNow: boolean }>();
  for (const c of prior) {
    if (!c.mine || !c.file || !c.fingerprint || c.inReplyTo) continue;
    const seen = earlier.get(c.fingerprint);
    earlier.set(c.fingerprint, {
      addressed: (seen?.addressed ?? false) || c.addressed === true,
      resolvedNow: (seen?.resolvedNow ?? false) || resolvedNow.has(c.id),
    });
  }

  let open = 0;
  let fixed = 0;
  let fixedThisRound = 0;
  for (const [fp, c] of earlier) {
    // A withdrawal reply also marks the thread addressed; it is not a fix.
    if (withdrawn.has(fp)) continue;
    if (c.resolvedNow) fixedThisRound++;
    if (c.addressed || c.resolvedNow) fixed++;
    else open++;
  }
  return {
    open,
    fixed,
    withdrawn: withdrawn.size,
    upheld: [...upheld].filter((fp) => !withdrawn.has(fp)).length,
    fixedThisRound,
    withdrawnThisRound: rulings.filter((r) => r.outcome === "withdrawn").length,
    new: input.newFindings,
  };
}
