import { describe, expect, test } from "bun:test";
import { loadFixture } from "./__fixtures__/load.ts";
import { chainStats, formatStats, statsByVersion, statsTotals, type StatsInput } from "./run-stats.ts";
import type { ReviewRun, RunFinding } from "../types/review-run.ts";

const built = loadFixture("small-commit").build();
const base: ReviewRun = {
  ...built,
  meta: { ...built.meta, slices: built.meta.slices.map(({ usage: _usage, ...s }) => s) },
};
const template = base.findings[0]!;

const finding = (id: string, extra: Partial<RunFinding> = {}): RunFinding => ({ ...template, id, ...extra });

function run(id: string, createdAt: string, over: Partial<ReviewRun>, costUsd = 1): ReviewRun {
  return { ...base, id, createdAt, resolved: [], findings: [], ...over, meta: { ...base.meta, ...over.meta, costUsd } };
}

const input = (r: ReviewRun, dismissed: string[] = []): StatsInput => ({
  run: r,
  state: { findingStatus: Object.fromEntries(dismissed.map((id) => [id, "dismissed" as const])) },
});

// Round 1 raises a, b and a pre-existing p. Round 2 fixes a and p, carries b
// and raises c, which the author dismisses. Round 3 fixes b.
const r1 = run("r1", "2026-10-01T00:00:00Z", {
  round: 1,
  findings: [finding("a", { severity: "blocker" }), finding("b", { severity: "should-fix" }), finding("p", { preexisting: true })],
  meta: { ...base.meta, promptVersion: "v1" },
});
const r2 = run("r2", "2026-10-02T00:00:00Z", {
  round: 2,
  priorRunId: "r1",
  resolved: [{ id: "a", title: "a" }, { id: "p", title: "p" }],
  findings: [finding("b", { severity: "should-fix", carriedFrom: "r1" }), finding("c", { severity: "question" })],
  meta: { ...base.meta, promptVersion: "v2", reviewScope: "incremental" },
});
const r3 = run("r3", "2026-10-03T00:00:00Z", {
  round: 3,
  priorRunId: "r2",
  resolved: [{ id: "b", title: "b" }],
  findings: [],
  meta: { ...base.meta, promptVersion: "v2", reviewScope: "incremental" },
});
const lone = run("lone", "2026-09-01T00:00:00Z", { findings: [finding("x")] });
const diffRun = run("d", "2026-10-04T00:00:00Z", { meta: { ...base.meta, kind: "diff" } });

const inputs = [input(r3), input(lone), input(r1), input(r2, ["c"]), input(diffRun)];

describe("chainStats", () => {
  const chains = chainStats(inputs);

  test("links runs by priorRunId into chains, newest chain first, diff runs left out", () => {
    expect(chains.map((c) => c.rounds.map((r) => r.id))).toEqual([["r1", "r2", "r3"], ["lone"]]);
  });

  test("counts new, carried and fixed findings per round", () => {
    expect(chains[0]!.rounds.map((r) => [r.new, r.newPreexisting, r.carried, r.resolved])).toEqual([
      [3, 1, 0, 0],
      [1, 0, 1, 2],
      [0, 0, 0, 1],
    ]);
  });

  test("totals raised, fixed, dismissed and open for the chain", () => {
    const c = chains[0]!;
    expect(c.raised).toEqual({ blocker: 1, "should-fix": 1, "nice-to-have": 0, question: 1 });
    expect(c.raisedPreexisting).toBe(1);
    expect([c.fixed, c.fixedPreexisting, c.dismissed, c.open, c.costUsd]).toEqual([3, 1, 1, 0, 3]);
  });

  test("findings still listed on the last run count as open unless dismissed", () => {
    expect(chains[1]!.open).toBe(1);
  });
});

describe("statsTotals", () => {
  test("resolution rate counts findings on the change only", () => {
    const t = statsTotals(chainStats(inputs));
    expect(t.chains).toBe(2);
    expect(t.meanRounds).toBe(2);
    expect(t.pastThreeRounds).toBe(0);
    expect(t.raised).toBe(4);
    expect(t.resolutionRate).toBe(0.5);
  });
});

describe("statsByVersion", () => {
  test("credits each fix to the version of the run that raised the finding", () => {
    const versions = statsByVersion(inputs);
    const v1 = versions.find((v) => v.promptVersion === "v1")!;
    const v2 = versions.find((v) => v.promptVersion === "v2")!;
    expect([v1.runs, v1.raised, v1.raisedPreexisting, v1.fixed, v1.fixedPreexisting]).toEqual([1, 2, 1, 2, 1]);
    expect([v2.runs, v2.raised, v2.fixed]).toEqual([2, 1, 0]);
    expect(versions.find((v) => v.promptVersion === "unrecorded")?.runs).toBe(1);
  });
});

describe("formatStats", () => {
  test("prints a block per chain and the totals", () => {
    const text = formatStats(chainStats(inputs), statsByVersion(inputs));
    expect(text).toContain("round 2  r2  1 new, 1 carried, 2 fixed, changes only");
    expect(text).toContain("fixed 3, dismissed 1, still open at last run 0, $1.00 per fixed finding");
    expect(text).toContain("resolution rate 50%");
    expect(text).toContain("By prompt version / instructions:");
  });

  test("adds token lines only for runs that recorded usage", () => {
    expect(formatStats(chainStats(inputs))).not.toContain("tokens");
    const usage = { input: 10, output: 5, reasoning: 0, cacheRead: 30, cacheWrite: 0, firstStep: { input: 10, cacheRead: 30, cacheWrite: 0 } };
    const withUsage = run("u", "2026-10-05T00:00:00Z", {
      findings: [finding("u1")],
      meta: { ...base.meta, slices: base.meta.slices.map((s) => ({ ...s, usage })) },
    });
    const chains = chainStats([input(withUsage)]);
    const n = base.meta.slices.length;
    expect(chains[0]!.rounds[0]!.cacheShare).toBe(0.75);
    expect(chains[0]!.usage.calls).toBe(n);
    expect(statsTotals(chains).usage.cacheRead).toBe(30 * n);
    const text = formatStats(chains);
    expect(text).toContain("75% cached");
    expect(text).toContain("first requests 75% from cache");
    expect(text).toContain(`tokens over ${n} agent calls`);
  });

  test("adds acted-on rates against the control spans only when runs recorded them", () => {
    expect(formatStats(chainStats(inputs), statsByVersion(inputs))).not.toContain("acted on");
    // r2 edited a and p (fixed) and b (still listed); the control span moved for a only.
    const r2Acted = {
      ...r2,
      priorActedOn: [
        { id: "a", acted: true, control: true },
        { id: "b", acted: true, control: false },
        { id: "p", acted: true, control: false },
      ],
    };
    // r3 left b alone.
    const r3Acted = { ...r3, priorActedOn: [{ id: "b", acted: false, control: false }] };
    const acted = [input(r1), input(r2Acted, ["c"]), input(r3Acted)];
    const chain = chainStats(acted)[0]!;
    expect(chain.acted).toEqual({
      change: { measured: 3, acted: 2, control: 1 },
      preexisting: { measured: 1, acted: 1, control: 0 },
      stillListed: 1,
    });
    const versions = statsByVersion(acted);
    // b was raised by r1, so r3's measurement of it counts toward v1 too.
    expect(versions.find((v) => v.promptVersion === "v1")?.acted.change.measured).toBe(3);
    expect(versions.find((v) => v.promptVersion === "v2")?.acted.change.measured).toBe(0);
    expect(statsTotals(chainStats(acted)).acted.change.acted).toBe(2);
    const text = formatStats(chainStats(acted), versions);
    expect(text).toContain("acted on: 2 of 3 edited (67%), control 33%, +33 points; pre-existing 1 of 1 edited (100%), control 0%, +100 points; 1 edited but still listed");
    expect(text).toContain("prior findings acted on: 2 of 3");
  });

  test("says so when nothing matches", () => {
    expect(formatStats([])).toBe("No complete review runs match.");
  });
});
