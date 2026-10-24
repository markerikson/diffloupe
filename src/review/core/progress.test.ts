import { roundProgress } from "./progress.ts";
import type { PriorComment } from "./context.ts";
import type { DisputeRuling } from "./disputes.ts";

const inline = (id: number, fingerprint: string, extra: Partial<PriorComment> = {}): PriorComment => ({
  id,
  file: "src/a.ts",
  line: id,
  author: "review-bot",
  body: `### Finding ${id}`,
  resolved: false,
  mine: true,
  fingerprint,
  ...extra,
});

const ruling = (fp: string, outcome: DisputeRuling["outcome"]): DisputeRuling => ({
  fp,
  outcome,
  file: "src/a.ts",
  line: "1",
  claim: "claim",
  author: "dev",
});

describe("roundProgress", () => {
  it("counts earlier findings as open, fixed earlier, or fixed now", () => {
    const progress = roundProgress({
      prior: [
        inline(1, "aaa111"),
        inline(2, "bbb222", { addressed: true }),
        inline(3, "ccc333"),
        inline(4, "ddd444", { inReplyTo: 1 }),
        { id: 5, file: "src/a.ts", line: 9, author: "dev", body: "comment", resolved: false, fingerprint: "eee555" },
      ],
      resolvedIds: [3],
      earlierRulings: [],
      rulings: [],
      newFindings: 2,
    });
    expect(progress).toEqual({
      open: 1, fixed: 2, withdrawn: 0, upheld: 0, fixedThisRound: 1, withdrawnThisRound: 0, new: 2,
    });
  });

  it("counts a finding posted twice once", () => {
    const progress = roundProgress({
      prior: [inline(1, "aaa111"), inline(2, "aaa111", { addressed: true })],
      resolvedIds: [],
      earlierRulings: [],
      rulings: [],
      newFindings: 0,
    });
    expect(progress.open).toBe(0);
    expect(progress.fixed).toBe(1);
  });

  it("keeps withdrawn findings out of fixed and open, and upheld ones open", () => {
    const progress = roundProgress({
      prior: [
        inline(1, "aaa111", { addressed: true }),
        inline(2, "bbb222"),
        inline(3, "ccc333"),
      ],
      resolvedIds: [],
      earlierRulings: [{ fp: "aaa111", outcome: "withdrawn", label: "old" }],
      rulings: [ruling("bbb222", "withdrawn"), ruling("ccc333", "upheld"), ruling("fff666", "withdrawn")],
      newFindings: 0,
    });
    expect(progress).toEqual({
      open: 1, fixed: 0, withdrawn: 3, upheld: 1, fixedThisRound: 0, withdrawnThisRound: 2, new: 0,
    });
  });
});
