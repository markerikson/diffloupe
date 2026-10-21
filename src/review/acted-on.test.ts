import { describe, expect, test } from "bun:test";
import { actedOn } from "./acted-on.ts";
import { buildReviewRun } from "./build-run.ts";
import { loadFixture } from "./__fixtures__/load.ts";
import type { LineHunk } from "./prior-run.ts";
import type { RunFinding } from "../types/review-run.ts";

const fixture = loadFixture("large-pr");
const prev = fixture.build();
const template = prev.findings[0]!;

function finding(id: string, file: string, line: number, extra: { endLine?: number; side?: "additions" | "deletions" } = {}): RunFinding {
  return {
    ...template,
    id,
    file,
    anchor: {
      ...template.anchor,
      file,
      side: extra.side ?? "additions",
      kind: "line",
      line,
      cited: { line, ...(extra.endLine ? { endLine: extra.endLine } : {}) },
    },
  };
}

const hunk = (oldStart: number, oldCount: number): LineHunk => ({ oldStart, oldCount, newStart: oldStart, newCount: 1 });

describe("actedOn", () => {
  test("a hunk overlapping the finding's span counts as acted", () => {
    const map = new Map([["a.ts", [hunk(14, 3)]]]);
    expect(actedOn([finding("f", "a.ts", 10, { endLine: 14 })], map)).toEqual([{ id: "f", acted: true, control: false }]);
    expect(actedOn([finding("g", "a.ts", 16)], map)[0]?.acted).toBe(true);
  });

  test("hunks elsewhere in the file, or no hunks at all, are not acted", () => {
    const map = new Map([["a.ts", [hunk(20, 2)]]]);
    expect(actedOn([finding("f", "a.ts", 10, { endLine: 19 }), finding("g", "b.ts", 10)], map)).toEqual([
      { id: "f", acted: false, control: false },
      { id: "g", acted: false, control: false },
    ]);
  });

  test("a pure insertion covers the line it follows", () => {
    const map = new Map([["a.ts", [hunk(12, 0)]]]);
    expect(actedOn([finding("f", "a.ts", 12)], map)[0]?.acted).toBe(true);
    expect(actedOn([finding("g", "a.ts", 13)], map)[0]?.acted).toBe(false);
  });

  test("the control span sits 35 lines below, or above once the finding starts past line 35", () => {
    const map = new Map([["a.ts", [hunk(45, 1), hunk(100, 1)]]]);
    expect(actedOn([finding("low", "a.ts", 10)], map)[0]).toEqual({ id: "low", acted: false, control: true });
    expect(actedOn([finding("high", "a.ts", 135)], map)[0]).toEqual({ id: "high", acted: false, control: true });
    expect(actedOn([finding("edge", "a.ts", 35)], map)[0]?.control).toBe(false);
  });

  test("a deleted file counts as acted", () => {
    const map = new Map([["gone.ts", [{ oldStart: 1, oldCount: 80, newStart: 0, newCount: 0 }]]]);
    expect(actedOn([finding("f", "gone.ts", 30)], map)[0]).toEqual({ id: "f", acted: true, control: true });
  });

  test("findings on the deletions side or with no line are left out", () => {
    const map = new Map([["a.ts", [hunk(1, 100)]]]);
    expect(actedOn([finding("d", "a.ts", 10, { side: "deletions" }), finding("z", "a.ts", 0)], map)).toEqual([]);
  });
});

describe("buildReviewRun records priorActedOn", () => {
  const empty = { ...fixture.input.result, record: { ...fixture.input.result.record, verifiedFindings: [] } };
  const first = prev.findings.find((f) => f.anchor.side === "additions" && f.anchor.cited.line > 0)!;

  test("when the prior run reviewed a different head", () => {
    const lineMap = new Map([[first.file, [hunk(first.anchor.cited.line, 1)]]]);
    const run = buildReviewRun({ ...fixture.input, head: "next", result: empty, previous: { run: prev, lineMap } });
    expect(run.priorActedOn?.find((e) => e.id === first.id)?.acted).toBe(true);
    expect(run.priorActedOn?.length).toBe(actedOn(prev.findings, lineMap).length);
  });

  test("not when there is no prior run, the head is the same, or the line map is missing", () => {
    const lineMap = new Map<string, LineHunk[]>();
    expect(buildReviewRun({ ...fixture.input, result: empty }).priorActedOn).toBeUndefined();
    expect(buildReviewRun({ ...fixture.input, result: empty, previous: { run: prev, lineMap } }).priorActedOn).toBeUndefined();
    expect(buildReviewRun({ ...fixture.input, head: "next", result: empty, previous: { run: prev } }).priorActedOn).toBeUndefined();
  });
});
