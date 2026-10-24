import { disputeRecord, earlierRulings, hasOpenDisputes, pendingDisputes, renderDisputes, rulingsFromDecisions } from "./disputes.ts";
import type { PriorComment } from "./context.ts";

const finding: PriorComment = {
  id: 10,
  file: "src/a.ts",
  line: 12,
  author: "review-bot",
  body: "### Lock released before the write\n\nExplanation.",
  resolved: false,
  mine: true,
  fingerprint: "aaa111",
};

const summary: PriorComment = {
  id: 5,
  author: "review-bot",
  body: "summary",
  resolved: false,
  mine: true,
  summaryClaims: [{ fp: "bbb222", file: "src/b.ts", line: "40", text: "Stale cache key" }],
};

const answer = (id: number, fp: string, verdict: "disputed" | "fixed", reason: string, author = "dev"): PriorComment => ({
  id,
  author,
  body: reason,
  resolved: false,
  responses: [{ fp, verdict, reason }],
});

describe("pendingDisputes", () => {
  it("matches answers to the bot's inline and summary findings", () => {
    const pending = pendingDisputes([
      finding,
      summary,
      answer(20, "aaa111", "disputed", "The caller holds the lock."),
      answer(21, "bbb222", "fixed", "Renamed the key.", "fix-agent[bot]"),
    ]);
    expect(pending).toEqual([
      {
        fp: "aaa111", commentId: 10, file: "src/a.ts", line: "12", claim: "Lock released before the write",
        verdict: "disputed", reason: "The caller holds the lock.", author: "dev", responseId: 20,
      },
      {
        fp: "bbb222", file: "src/b.ts", line: "40", claim: "Stale cache key",
        verdict: "fixed", reason: "Renamed the key.", author: "fix-agent[bot]", responseId: 21,
      },
    ]);
    expect(hasOpenDisputes(pending)).toBe(true);
  });

  it("ignores answers to findings the bot never made", () => {
    expect(pendingDisputes([finding, answer(20, "ccc333", "disputed", "No.")])).toEqual([]);
  });

  it("keeps only the latest answer per finding", () => {
    const pending = pendingDisputes([
      finding,
      answer(30, "aaa111", "disputed", "Second try."),
      answer(20, "aaa111", "fixed", "First try."),
    ]);
    expect(pending.map((d) => [d.verdict, d.reason])).toEqual([["disputed", "Second try."]]);
  });

  it("skips a finding already closed out or ruled on", () => {
    expect(pendingDisputes([{ ...finding, addressed: true }, answer(20, "aaa111", "disputed", "No.")])).toEqual([]);
    const ruled = { ...summary, rulings: [{ fp: "aaa111", outcome: "upheld" as const, label: "Upheld: lock" }] };
    expect(pendingDisputes([finding, ruled, answer(20, "aaa111", "disputed", "Again.")])).toEqual([]);
  });

  it("does not treat the bot's own comments as answers", () => {
    const own = { ...answer(20, "aaa111", "disputed", "x"), mine: true };
    expect(pendingDisputes([finding, own])).toEqual([]);
  });
});

describe("earlierRulings", () => {
  it("reads rulings from the bot's summary only, once per finding", () => {
    const r = { fp: "aaa111", outcome: "withdrawn" as const, label: "Withdrawn: lock" };
    const other: PriorComment = { id: 6, author: "dev", body: "", resolved: false, rulings: [{ ...r, outcome: "upheld" }] };
    expect(earlierRulings([{ ...summary, rulings: [r, r] }, other])).toEqual([r]);
  });
});

describe("rulingsFromDecisions", () => {
  const pending = pendingDisputes([
    finding,
    summary,
    answer(20, "aaa111", "disputed", "The caller holds the lock."),
    answer(21, "bbb222", "fixed", "Renamed."),
  ]);

  it("keeps one valid ruling per open dispute", () => {
    const rulings = rulingsFromDecisions(
      [
        { fp: "AAA111", outcome: "withdrawn", note: "  The caller\n holds it. " },
        { fp: "aaa111", outcome: "upheld" },
        { fp: "bbb222", outcome: "withdrawn" },
        { fp: "zzz999", outcome: "upheld" },
      ],
      pending,
    );
    expect(rulings).toEqual([
      {
        fp: "aaa111", outcome: "withdrawn", note: "The caller holds it.", file: "src/a.ts", line: "12",
        claim: "Lock released before the write", author: "dev", commentId: 10,
      },
    ]);
  });

  it("ignores an outcome other than withdrawn or upheld", () => {
    expect(rulingsFromDecisions([{ fp: "aaa111", outcome: "maybe" }], pending)).toEqual([]);
    expect(rulingsFromDecisions(undefined, pending)).toEqual([]);
  });

  it("records rulings, earlier rulings and disputes left without one", () => {
    const earlier = [{ fp: "ddd444", outcome: "upheld" as const, label: "Upheld: old" }];
    expect(disputeRecord(earlier, [], pending)).toEqual([
      { fp: "ddd444", outcome: "upheld", earlier: true, claim: "Upheld: old" },
      { fp: "aaa111", outcome: "unjudged", file: "src/a.ts", line: "12", claim: "Lock released before the write" },
    ]);
  });
});

describe("renderDisputes", () => {
  it("lists disputes and reported fixes in their own sections", () => {
    const text = renderDisputes(
      pendingDisputes([
        finding,
        summary,
        answer(20, "aaa111", "disputed", "The caller holds the lock."),
        answer(21, "bbb222", "fixed", "Renamed."),
      ]),
    );
    expect(text).toContain("## Findings the author disputes");
    expect(text).toContain("- fp=aaa111 `src/a.ts:12` (your comment id=10): Lock released before the write");
    expect(text).toContain("@dev replied: The caller holds the lock.");
    expect(text).toContain("## Findings the author says are fixed");
    expect(text).toContain("- fp=bbb222 `src/b.ts:40` (in your summary): Stale cache key");
  });

  it("is empty with nothing answered", () => {
    expect(renderDisputes([])).toBe("");
  });
});
