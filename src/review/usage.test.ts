import { describe, expect, test } from "bun:test";
import { loadFixture } from "./__fixtures__/load.ts";
import {
  cacheShare,
  formatUsage,
  hasUsage,
  median,
  runUsageTotals,
  stagesFromRecord,
  toRunUsage,
  toStageCost,
  withRecordUsage,
} from "./usage.ts";

const raw = (input: number, read: number, write: number, first?: [number, number, number]) => ({
  input_tokens: input,
  output_tokens: 10,
  reasoning_tokens: 5,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  ...(first
    ? { first_step: { input_tokens: first[0], cache_read_input_tokens: first[1], cache_creation_input_tokens: first[2] } }
    : {}),
});

describe("toRunUsage", () => {
  test("renames the core's token fields and keeps the first step when present", () => {
    expect(toRunUsage(raw(1, 2, 3, [4, 5, 6]))).toEqual({
      input: 1,
      output: 10,
      reasoning: 5,
      cacheRead: 2,
      cacheWrite: 3,
      firstStep: { input: 4, cacheRead: 5, cacheWrite: 6 },
    });
    expect(toRunUsage(raw(1, 2, 3))?.firstStep).toBeUndefined();
  });

  test("is undefined for a missing or tokenless value", () => {
    expect(toRunUsage(undefined)).toBeUndefined();
    expect(toRunUsage({ costUsd: 1 })).toBeUndefined();
  });
});

describe("stage costs", () => {
  test("leaves out stages that were cached or did not run", () => {
    expect(toStageCost({ cached: true, costUsd: 1, usage: raw(1, 0, 0) })).toBeUndefined();
    expect(toStageCost({ costUsd: 0, wallMs: 0 })).toBeUndefined();
    expect(toStageCost({ costUsd: 0.2, wallMs: 30 })).toEqual({ costUsd: 0.2, wallMs: 30 });
  });

  test("maps merge, walk and intentDraft to coordinator, walkthrough and intent", () => {
    const stages = stagesFromRecord({
      merge: { costUsd: 0.3, wallMs: 10, usage: raw(1, 2, 3) },
      walk: { costUsd: 0.1, wallMs: 5 },
    });
    expect(Object.keys(stages ?? {})).toEqual(["coordinator", "walkthrough"]);
    expect(stages?.coordinator?.usage?.cacheRead).toBe(2);
    expect(stagesFromRecord(null)).toBeUndefined();
  });
});

describe("withRecordUsage", () => {
  const run = loadFixture("large-pr").build();
  const record = {
    sliceRuns: run.meta.slices.map((s, i) => ({ unit: s.unit, part: s.part, usage: raw(100 * (i + 1), 0, 0) })),
    merge: { costUsd: 0.4, wallMs: 1, usage: raw(7, 0, 0) },
  };

  test("fills slices by position and stages from an older run's saved record", () => {
    expect(hasUsage(run)).toBe(false);
    const filled = withRecordUsage(run, record);
    expect(filled.meta.slices.map((s) => s.usage?.input)).toEqual([100, 200, 300]);
    expect(filled.meta.stages?.coordinator?.usage?.input).toBe(7);
    expect(hasUsage(filled)).toBe(true);
  });

  test("skips a slice whose unit does not match, rather than misattribute tokens", () => {
    const shifted = { sliceRuns: [{ unit: "Other", part: 1, usage: raw(1, 0, 0) }] };
    expect(withRecordUsage(run, shifted).meta.slices[0]!.usage).toBeUndefined();
  });
});

describe("totals", () => {
  test("sums every call and takes first-request shares from slices only", () => {
    const run = loadFixture("large-pr").build();
    const filled = withRecordUsage(run, {
      sliceRuns: [
        { unit: run.meta.slices[0]!.unit, part: run.meta.slices[0]!.part, usage: raw(10, 80, 10, [10, 0, 90]) },
        { unit: run.meta.slices[1]!.unit, part: run.meta.slices[1]!.part, usage: raw(10, 90, 0, [10, 90, 0]) },
      ],
      merge: { costUsd: 0.4, wallMs: 1, usage: raw(100, 0, 0, [100, 0, 0]) },
    });
    const t = runUsageTotals(filled);
    expect([t.calls, t.input, t.cacheRead, t.cacheWrite]).toEqual([3, 120, 170, 10]);
    expect(t.firstStepShares).toEqual([0, 0.9]);
    expect(formatUsage(t)).toBe("300 prompt (57% from cache), 30 output, 15 reasoning; first requests 45% from cache (median of 2)");
  });

  test("prints nothing without recorded usage", () => {
    const run = loadFixture("large-pr").build();
    expect(formatUsage(runUsageTotals(run))).toBeUndefined();
  });

  test("cacheShare and median handle empty input", () => {
    expect(cacheShare({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
  });
});
