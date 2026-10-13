import { describe, expect, test } from "bun:test";
import type { DiffAnchor, GuideStop, RunFinding } from "../../types/review-run.ts";
import { fileAnnotations } from "./annotations.ts";
import { fileNotes } from "./file-notes.ts";

function finding(id: string, anchor: DiffAnchor, severity: RunFinding["severity"] = "should-fix"): RunFinding {
  return {
    id,
    file: anchor.file,
    anchor,
    severity,
    category: "correctness",
    title: `Title ${id}`,
    explanation: "",
    evidence: "",
    confidence: "high",
  };
}

function stop(id: string, locations: DiffAnchor[], importance: GuideStop["importance"] = "normal"): GuideStop {
  return { id, chapterId: "c1", index: 0, title: `Stop ${id}`, importance, locations };
}

type Location = GuideStop["locations"][number];

const line = (file: string, n: number, extra: Partial<Location> = {}): Location => ({
  file,
  side: "additions",
  kind: "line",
  line: n,
  cited: { line: n },
  ...extra,
});

function notesFor(run: { findings: RunFinding[]; overCapFindings?: RunFinding[]; stops: GuideStop[] }, file = "a.ts") {
  const map = fileAnnotations({ overCapFindings: [], ...run }, { showOverCap: true });
  return fileNotes(map.get(file) ?? [], run.stops);
}

describe("fileNotes", () => {
  test("labels findings with severity, line and title", () => {
    const [n] = notesFor({ findings: [finding("f1", line("a.ts", 42, { endLine: 45 }), "blocker")], stops: [] });
    expect(n).toMatchObject({
      kind: "finding",
      id: "f1",
      line: "L42",
      side: "additions",
      label: "Blocker finding, lines 42-45: Title f1",
    });
  });

  test("numbers stops in guide order and names the location", () => {
    const later = stop("s2", [line("a.ts", 3), line("a.ts", 9, { label: "second spot" })], "critical");
    const notes = notesFor({ findings: [], stops: [stop("s1", [line("b.ts", 1)]), later] });
    expect(notes.map((n) => n.label)).toEqual([
      "Critical walkthrough stop 2 (location 1 of 2), line 3: Stop s2",
      "Critical walkthrough stop 2 (location 2 of 2), line 9: Stop s2",
    ]);
    expect(notes[1]).toMatchObject({ kind: "stop", id: "s2", location: 1, number: 2 });
    expect(notes[1]!.tooltip).toContain("second spot");
  });

  test("deletions-side anchors keep their side and say old line", () => {
    const [n] = notesFor({ findings: [], stops: [stop("s", [line("a.ts", 30, { side: "deletions" })])] });
    expect(n).toMatchObject({ side: "deletions", line: "L30", label: "Walkthrough stop 1, old line 30: Stop s" });
  });

  test("file-level anchors show `file` and explain the cited lines", () => {
    const anchor: DiffAnchor = { ...line("a.ts", 0), kind: "file", cited: { line: 200 }, reason: "far-from-diff" };
    const [n] = notesFor({ findings: [finding("f", anchor)], stops: [] });
    expect(n).toMatchObject({ line: "file", label: "Should fix finding, whole file: Title f" });
    expect(n!.tooltip).toContain("line 200");
  });

  test("nearby anchors show the cited line", () => {
    const anchor: DiffAnchor = { ...line("a.ts", 10), kind: "nearby", cited: { line: 14 } };
    const [n] = notesFor({ findings: [finding("f", anchor)], stops: [] });
    expect(n!.line).toBe("L14");
  });

  test("marks over-cap findings", () => {
    const [n] = notesFor({ findings: [], overCapFindings: [finding("o", line("a.ts", 2), "nice-to-have")], stops: [] });
    expect(n).toMatchObject({ overCap: true });
    expect(n!.tooltip).toContain("over the posting cap");
  });
});
