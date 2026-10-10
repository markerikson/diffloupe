import { describe, expect, it } from "bun:test";
import { loadFixture } from "../../review/__fixtures__/load.ts";
import type { RunFinding, RunFile } from "../../types/review-run.ts";
import { summarizeFindings } from "./finding-summary.ts";

const base = loadFixture("large-pr").build().findings[0] as RunFinding;

const finding = (over: Partial<RunFinding>): RunFinding => ({ ...base, ...over });
const file = (path: string, surface: RunFile["surface"]): RunFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 0,
  isBinary: false,
  groupId: "",
  classification: "code",
  ...(surface ? { surface } : {}),
});

describe("summarizeFindings", () => {
  it("matches the GitHub verdicts on the large-pr fixture", () => {
    const s = summarizeFindings(loadFixture("large-pr").build());
    expect(s.merge.label).toBe("Merge risk: high");
    expect(s.prod?.level).toBe("high");
    expect(s.counts.map(([sev]) => sev)).toEqual(["blocker", "should-fix", "nice-to-have", "question"]);
  });

  it("keeps product findings in view and collapses tooling ones on a product change", () => {
    const s = summarizeFindings({
      files: [file("src/a.ts", "product"), file("scripts/b.ts", "tooling")],
      findings: [
        finding({ id: "a", file: "src/a.ts", surface: "product", severity: "question" }),
        finding({ id: "b", file: "scripts/b.ts", surface: "tooling", severity: "blocker" }),
      ],
    });
    expect(s.title).toBe("Prod risk");
    expect(s.main.map((g) => g.file)).toEqual(["src/a.ts"]);
    expect(s.other.map((g) => g.file)).toEqual(["scripts/b.ts"]);
    expect(s.prod?.label).toBe("Prod risk: low");
    expect(s.merge.label).toBe("Merge risk: high");
  });

  it("keeps tooling findings in view when the change is all tooling", () => {
    const s = summarizeFindings({
      files: [file("scripts/b.ts", "tooling")],
      findings: [finding({ id: "b", file: "scripts/b.ts", surface: "tooling" })],
    });
    expect(s.title).toBe("Main findings — tooling");
    expect(s.main).toHaveLength(1);
    expect(s.prod?.label).toBe("Prod risk: none");
  });

  it("lists everything and skips the prod verdict on runs without surfaces", () => {
    const s = summarizeFindings({
      files: [file("src/a.ts", undefined)],
      findings: [(({ surface: _, ...rest }) => rest)(finding({ id: "a", file: "src/a.ts" }))],
    });
    expect(s.prod).toBeUndefined();
    expect(s.title).toBe("Findings");
    expect(s.main).toHaveLength(1);
  });

  it("moves findings that repeat a human comment out of the counts", () => {
    const s = summarizeFindings({
      files: [],
      findings: [finding({ id: "a", severity: "blocker", repeatOf: 3 }), finding({ id: "b", severity: "question" })],
    });
    expect(s.echoed.map((f) => f.id)).toEqual(["a"]);
    expect(s.merge.label).toBe("Merge risk: low");
    expect(s.counts).toEqual([["question", 1]]);
  });

  it("groups findings by file in severity order", () => {
    const s = summarizeFindings({
      files: [],
      findings: [
        finding({ id: "q", file: "src/a.ts", severity: "question", surface: "product" }),
        finding({ id: "x", file: "src/b.ts", severity: "blocker", surface: "product" }),
        finding({ id: "s", file: "src/a.ts", severity: "should-fix", surface: "product" }),
      ],
    });
    expect(s.main.map((g) => [g.file, g.findings.map((f) => f.id)])).toEqual([
      ["src/b.ts", ["x"]],
      ["src/a.ts", ["s", "q"]],
    ]);
  });
});
