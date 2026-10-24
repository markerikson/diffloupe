/**
 * Answers to the bot's findings, and the review's ruling on each.
 *
 * An author, or an agent working for one, answers a finding with a response
 * marker (see `readResponses`). A `disputed` answer goes to the coordinator,
 * which reads the code and the reason and either withdraws the finding or
 * upholds it. It does that once per finding: the ruling is written into the
 * summary comment as a `dispute` marker and carried forward on every review, so
 * a later push does not reopen the argument. A withdrawn finding is never
 * raised again on the pull request. An upheld one stays open for a human.
 *
 * A `fixed` answer is not a dispute. It is shown to the coordinator next to the
 * finding, and the normal close-out decides whether the code agrees.
 */
import { stripMarkers } from "./lib/marker.ts";
import type { DisputeOutcome, PriorComment, PriorRuling } from "./context.ts";

export interface Dispute {
  fp: string;
  verdict: "disputed" | "fixed";
  /** The bot's inline comment carrying the finding. Absent for a finding that lives only in the summary. */
  commentId?: number;
  file: string;
  line: string;
  /** The finding's title, or its summary bullet when it has no comment of its own. */
  claim: string;
  reason: string;
  author: string;
  responseId: number;
}

export interface DisputeRuling {
  fp: string;
  outcome: DisputeOutcome;
  note?: string;
  file: string;
  line: string;
  claim: string;
  author: string;
  commentId?: number;
}

/** Rulings from earlier reviews, read from the bot's summary comment. */
export function earlierRulings(prior: PriorComment[]): PriorRuling[] {
  const seen = new Set<string>();
  const out: PriorRuling[] = [];
  for (const c of prior) {
    if (!c.mine || c.file) continue;
    for (const r of c.rulings ?? []) {
      if (seen.has(r.fp)) continue;
      seen.add(r.fp);
      out.push(r);
    }
  }
  return out;
}

function headline(body: string): string {
  const first = stripMarkers(body).split("\n").find((l) => l.trim()) ?? "";
  return first.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Answers the coordinator has not ruled on yet, one per finding.
 *
 * Only answers naming a finding the bot actually made on this pull request
 * count, and the latest answer per finding wins, so an author who restates a
 * dispute does not get two rulings. A finding that is already settled — closed
 * out as fixed, or ruled on by an earlier review — is finished.
 */
export function pendingDisputes(prior: PriorComment[]): Dispute[] {
  const ruled = new Set(earlierRulings(prior).map((r) => r.fp));
  const claims = new Map<string, Omit<Dispute, "verdict" | "reason" | "author" | "responseId">>();
  for (const c of prior) {
    if (!c.mine) continue;
    if (c.file && c.fingerprint && !c.inReplyTo) {
      if (c.addressed) continue;
      claims.set(c.fingerprint, {
        fp: c.fingerprint,
        commentId: c.id,
        file: c.file,
        line: c.line === undefined ? "?" : String(c.line),
        claim: headline(c.body),
      });
    }
    for (const s of c.summaryClaims ?? []) {
      if (!claims.has(s.fp)) claims.set(s.fp, { fp: s.fp, file: s.file, line: s.line, claim: s.text ?? "" });
    }
  }
  const latest = new Map<string, Dispute>();
  for (const c of [...prior].sort((a, b) => a.id - b.id)) {
    if (c.mine) continue;
    for (const r of c.responses ?? []) {
      const claim = claims.get(r.fp);
      if (!claim || ruled.has(r.fp)) continue;
      latest.set(r.fp, { ...claim, verdict: r.verdict, reason: r.reason, author: c.author, responseId: c.id });
    }
  }
  return [...latest.values()];
}

/** Whether there is a dispute for the coordinator to rule on. */
export function hasOpenDisputes(pending: Dispute[]): boolean {
  return pending.some((d) => d.verdict === "disputed");
}

/** The coordinator prompt's section on answered findings. Empty when there are none. */
export function renderDisputes(pending: Dispute[]): string {
  if (!pending.length) return "";
  const disputed = pending.filter((d) => d.verdict === "disputed");
  const fixed = pending.filter((d) => d.verdict === "fixed");
  const item = (d: Dispute) => {
    const reason = d.reason.replace(/\s+/g, " ").slice(0, 1200) || "(no reason given)";
    const thread = d.commentId ? ` (your comment id=${d.commentId})` : " (in your summary)";
    return `- fp=${d.fp} \`${d.file}:${d.line}\`${thread}: ${d.claim}\n  @${d.author} replied: ${reason}`;
  };
  const lines: string[] = [];
  if (disputed.length) {
    lines.push(
      "## Findings the author disputes",
      "",
      "The author, or an agent working for them, says these findings of yours are wrong. Rule on",
      "each one in `disputes`, by its `fp`. Open the code and weigh the reason against it.",
      "",
      "- `withdrawn` when the reason holds: the finding misreads the code, the behavior is",
      "  intended and the reply shows why that is safe, or the case cannot happen. The finding is",
      "  never raised on this pull request again, so do not report it in any other form.",
      "- `upheld` when the code still has the problem the finding describes. A reply that only",
      "  disagrees, or promises a later fix, does not change the code. A human reviewer decides",
      "  what happens next.",
      "",
      "Every dispute gets a `note`: one sentence the author will read, saying what in the code",
      "decided it. You rule once; no later review reopens it.",
      "",
    );
    for (const d of disputed) lines.push(item(d));
    lines.push("");
  }
  if (fixed.length) {
    lines.push(
      "## Findings the author says are fixed",
      "",
      "Check each against the current code. A finding with a comment of its own goes in `resolved`",
      "when it is fixed, as in step 5. A finding in your summary is simply not reported again.",
      "Neither goes in `disputes`.",
      "",
    );
    for (const d of fixed) lines.push(item(d));
    lines.push("");
  }
  return lines.join("\n");
}

/** One disputed finding as the run record keeps it. */
export interface DisputeRecord {
  fp: string;
  /** `unjudged` when the coordinator did not rule; the next review will. */
  outcome: DisputeOutcome | "unjudged";
  /** Ruled by an earlier review and carried forward. */
  earlier?: boolean;
  file?: string;
  line?: string;
  claim?: string;
  note?: string;
}

/** Every disputed finding on the pull request and where it stands after this review. */
export function disputeRecord(earlier: PriorRuling[], rulings: DisputeRuling[], pending: Dispute[]): DisputeRecord[] {
  const ruled = new Set(rulings.map((r) => r.fp));
  return [
    ...earlier.map((r) => ({ fp: r.fp, outcome: r.outcome, earlier: true, claim: r.label })),
    ...rulings.map(({ fp, outcome, file, line, claim, note }) => ({ fp, outcome, file, line, claim, ...(note ? { note } : {}) })),
    ...pending
      .filter((d) => d.verdict === "disputed" && !ruled.has(d.fp))
      .map(({ fp, file, line, claim }) => ({ fp, outcome: "unjudged" as const, file, line, claim })),
  ];
}

/**
 * The coordinator's rulings, checked against the disputes it was given. A
 * ruling on anything else, or with an outcome other than the two, is ignored;
 * a dispute it skipped stays open for the next review.
 */
export function rulingsFromDecisions(
  decisions: { fp?: unknown; outcome?: unknown; note?: unknown }[] | undefined,
  pending: Dispute[],
): DisputeRuling[] {
  const open = new Map(pending.filter((d) => d.verdict === "disputed").map((d) => [d.fp, d]));
  const out: DisputeRuling[] = [];
  for (const r of decisions ?? []) {
    const d = typeof r.fp === "string" ? open.get(r.fp.toLowerCase()) : undefined;
    if (!d || (r.outcome !== "withdrawn" && r.outcome !== "upheld")) continue;
    open.delete(d.fp);
    const note = typeof r.note === "string" ? r.note.replace(/\s+/g, " ").trim() : "";
    out.push({
      fp: d.fp,
      outcome: r.outcome,
      file: d.file,
      line: d.line,
      claim: d.claim,
      author: d.author,
      ...(note ? { note } : {}),
      ...(d.commentId ? { commentId: d.commentId } : {}),
    });
  }
  return out;
}
