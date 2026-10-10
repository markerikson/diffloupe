import { describe, expect, test } from "bun:test";
import { loadFixture } from "../../review/__fixtures__/load.ts";
import type { DiffAnchor, GuideStop, RunFinding } from "../../types/review-run.ts";
import { anchorNote, anchorSelection, fileAnnotations } from "./annotations.ts";

const FIXTURES = ["large-pr", "renames", "worktree", "small-commit", "docs-only"];

function finding(id: string, anchor: DiffAnchor, severity: RunFinding["severity"] = "should-fix"): RunFinding {
  return {
    id,
    file: anchor.file,
    anchor,
    severity,
    category: "correctness",
    title: id,
    explanation: "",
    evidence: "",
    confidence: "high",
  };
}

function stop(id: string, locations: DiffAnchor[]): GuideStop {
  return { id, chapterId: "c1", index: 0, title: id, importance: "normal", locations };
}

const line = (file: string, n: number, extra: Partial<DiffAnchor> = {}): DiffAnchor => ({
  file,
  side: "additions",
  kind: "line",
  line: n,
  cited: { line: n },
  ...extra,
});

describe("fileAnnotations", () => {
  for (const name of FIXTURES) {
    test(`${name}: every finding and stop location becomes exactly one annotation`, () => {
      const run = loadFixture(name).build();
      const map = fileAnnotations(run);
      const all = [...map.values()].flat();
      const findingIds = all.flatMap((a) => (a.metadata.kind === "finding" ? [a.metadata.finding.id] : []));
      expect(findingIds.sort()).toEqual(run.findings.map((f) => f.id).sort());
      const stopLocations = all.filter((a) => a.metadata.kind === "stop").length;
      expect(stopLocations).toBe(run.stops.reduce((n, s) => n + s.locations.length, 0));
      for (const [path, list] of map)
        for (const a of list) {
          const anchor = a.metadata.kind === "finding" ? a.metadata.finding.anchor : a.metadata.stop.locations[a.metadata.location]!;
          expect(anchor.file).toBe(path);
        }
    });
  }

  test("large-pr: file anchors sit at line 0 and nearby anchors at their snapped line", () => {
    const run = loadFixture("large-pr").build();
    const map = fileAnnotations(run);
    for (const f of run.findings) {
      const a = map.get(f.anchor.file)!.find((x) => x.metadata.kind === "finding" && x.metadata.finding.id === f.id)!;
      expect(a.side).toBe(f.anchor.side);
      expect(a.lineNumber).toBe(f.anchor.kind === "file" ? 0 : f.anchor.line);
    }
    expect(run.findings.some((f) => f.anchor.kind === "nearby")).toBe(true);
    expect(run.findings.some((f) => f.anchor.kind === "file")).toBe(true);
  });

  test("over-cap findings appear only when asked", () => {
    const run = loadFixture("large-pr").build();
    expect(run.overCapFindings.length).toBeGreaterThan(0);
    const count = (show: boolean) =>
      [...fileAnnotations(run, { showOverCap: show }).values()]
        .flat()
        .filter((a) => a.metadata.kind === "finding" && a.metadata.overCap).length;
    expect(count(false)).toBe(0);
    expect(count(true)).toBe(run.overCapFindings.length);
  });

  test("passes the deletions side through", () => {
    const map = fileAnnotations({
      findings: [finding("f1", line("a.ts", 4, { side: "deletions" }))],
      overCapFindings: [],
      stops: [],
    });
    expect(map.get("a.ts")).toMatchObject([{ side: "deletions", lineNumber: 4 }]);
  });

  test("orders a shared line: findings by severity, then stops", () => {
    const map = fileAnnotations({
      findings: [finding("q", line("a.ts", 5), "question"), finding("b", line("a.ts", 5), "blocker")],
      overCapFindings: [finding("o", line("a.ts", 5), "blocker")],
      stops: [stop("s", [line("a.ts", 5)]), stop("early", [line("a.ts", 2)])],
    }, { showOverCap: true });
    const ids = map.get("a.ts")!.map((a) => (a.metadata.kind === "finding" ? a.metadata.finding.id : a.metadata.stop.id));
    expect(ids).toEqual(["early", "b", "q", "o", "s"]);
  });
});

describe("anchorSelection and anchorNote", () => {
  test("line anchors select line..endLine on their side", () => {
    expect(anchorSelection(line("a.ts", 3, { endLine: 6 }))).toEqual({ start: 3, end: 6, side: "additions" });
    expect(anchorSelection(line("a.ts", 3))).toEqual({ start: 3, end: 3, side: "additions" });
    expect(anchorNote(line("a.ts", 3))).toBeUndefined();
  });

  test("nearby anchors name the cited line", () => {
    const a: DiffAnchor = { ...line("a.ts", 10), kind: "nearby", cited: { line: 14 } };
    expect(anchorSelection(a)).toEqual({ start: 10, end: 10, side: "additions" });
    expect(anchorNote(a)).toContain("line 14");
  });

  test("file anchors select nothing and explain why", () => {
    const a: DiffAnchor = { ...line("a.ts", 0), kind: "file", cited: { line: 200, endLine: 210 }, reason: "far-from-diff" };
    expect(anchorSelection(a)).toBeNull();
    expect(anchorNote(a)).toContain("lines 200-210");
    expect(anchorNote({ ...a, cited: { line: 0 }, reason: "no-line" })).toBe("About the whole file; no line cited.");
  });
});
