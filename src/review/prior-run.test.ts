import { describe, expect, test } from "bun:test";
import { buildReviewRun } from "./build-run.ts";
import { loadFixture } from "./__fixtures__/load.ts";
import { mapLine, parseZeroContextDiff, priorComments } from "./prior-run.ts";

describe("mapLine", () => {
  const hunks = [
    { oldStart: 10, oldCount: 0, newStart: 11, newCount: 3 },
    { oldStart: 20, oldCount: 2, newStart: 24, newCount: 1 },
    { oldStart: 30, oldCount: 4, newStart: 33, newCount: 0 },
  ];

  test("lines before every edit stay put", () => {
    expect(mapLine(hunks, 5)).toBe(5);
    expect(mapLine(hunks, 10)).toBe(10);
  });

  test("lines after an insertion move down by its size", () => {
    expect(mapLine(hunks, 11)).toBe(14);
  });

  test("an edited line maps to the start of its replacement", () => {
    expect(mapLine(hunks, 21)).toBe(24);
  });

  test("shifts accumulate across edits and deletions", () => {
    expect(mapLine(hunks, 25)).toBe(27);
    expect(mapLine(hunks, 40)).toBe(38);
  });
});

test("parseZeroContextDiff keys hunks by the new path and skips deleted files", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -3 +3,2 @@ fn",
    "-x",
    "+y",
    "+z",
    "@@ -10,0 +12 @@",
    "+w",
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
  ].join("\n");
  const map = parseZeroContextDiff(diff);
  expect([...map.keys()]).toEqual(["a.ts"]);
  expect(map.get("a.ts")).toEqual([
    { oldStart: 3, oldCount: 1, newStart: 3, newCount: 2 },
    { oldStart: 10, oldCount: 0, newStart: 12, newCount: 1 },
  ]);
});

describe("carrying findings from the prior run", () => {
  const fixture = loadFixture("large-pr");
  const prev = fixture.build();
  const [fixed, open, ...rest] = prev.findings;

  test("prior findings become the bot's own numbered comments", () => {
    const prior = priorComments(prev);
    expect(prior.map((c) => c.id)).toEqual(prev.findings.map((_, i) => i + 1));
    expect(prior.every((c) => c.mine && c.file && c.fingerprint)).toBe(true);
  });

  test("fixed ones are resolved, unreported ones carried, re-reported ones marked", () => {
    if (!fixed || !open) throw new Error("fixture needs two findings");
    const record = fixture.input.result.record as Record<string, unknown> & { verifiedFindings: { title: string }[] };
    const kept = record.verifiedFindings.filter((f) => f.title !== fixed.title && f.title !== open.title);
    const run = buildReviewRun({
      ...fixture.input,
      id: "second",
      result: {
        ...fixture.input.result,
        record: { ...record, verifiedFindings: kept, resolved: [{ id: 1, note: "guard added" }] },
      },
      previous: { run: prev },
    });
    expect(run.resolved).toEqual([{ id: fixed.id, title: fixed.title, file: fixed.file, note: "guard added" }]);
    const carried = run.findings.find((f) => f.id === open.id);
    expect(carried?.carriedFrom).toBe(prev.id);
    expect(run.findings.some((f) => f.id === fixed.id)).toBe(false);
    for (const f of rest) expect(run.findings.find((x) => x.id === f.id)?.carriedFrom).toBe(prev.id);
    const group = run.groups.find((g) => g.files.includes(open.file) && !run.groups.some((c) => c.parentId === g.id));
    expect(group?.findingIds).toContain(open.id);
  });

  test("dismissed findings are not carried", () => {
    if (!open) throw new Error("fixture needs a finding");
    const run = buildReviewRun({
      ...fixture.input,
      result: { ...fixture.input.result, record: { ...fixture.input.result.record, verifiedFindings: [] } },
      previous: { run: prev, dismissed: [open.id] },
    });
    expect(run.findings.some((f) => f.id === open.id)).toBe(false);
  });
});
