import { describe, expect, it } from "bun:test";
import type { ParsedDiff, DiffFile, DiffHunk } from "../../types/diff.js";
import type { ClassifiedFile } from "../../types/loader.js";
import { calculateDiffMetrics, selectStrategy } from "./strategy-selector.js";

// ============================================================================
// Test helpers
// ============================================================================

/** Create a minimal DiffHunk with specified line counts */
function createHunk(adds: number, deletes: number): DiffHunk {
  const lines = [
    ...Array.from({ length: adds }, (_, i) => ({
      type: "add" as const,
      content: `added line ${i}`,
      oldLineNumber: undefined,
      newLineNumber: i + 1,
    })),
    ...Array.from({ length: deletes }, (_, i) => ({
      type: "delete" as const,
      content: `deleted line ${i}`,
      oldLineNumber: i + 1,
      newLineNumber: undefined,
    })),
  ];

  return {
    oldStart: 1,
    oldLines: deletes,
    newStart: 1,
    newLines: adds,
    header: `@@ -1,${deletes} +1,${adds} @@`,
    lines,
  };
}

/** Create a minimal DiffFile */
function createFile(
  path: string,
  adds: number = 10,
  deletes: number = 5
): DiffFile {
  return {
    path,
    status: "modified",
    hunks: [createHunk(adds, deletes)],
    isBinary: false,
  };
}

/** Create a ClassifiedFile from a DiffFile */
function classify(
  file: DiffFile,
  tier: 1 | 2 | 3 = 1,
  tokens: number = 100
): ClassifiedFile {
  return {
    file,
    tier,
    reason: tier === 1 ? "source code" : tier === 2 ? "config" : "lock file",
    estimatedTokens: tokens,
  };
}

/** Create N classified files for testing */
function createClassifiedFiles(
  count: number,
  tier: 1 | 2 | 3 = 1,
  tokensEach: number = 100
): ClassifiedFile[] {
  return Array.from({ length: count }, (_, i) =>
    classify(createFile(`file${i}.ts`), tier, tokensEach)
  );
}

/** Create a ParsedDiff from ClassifiedFiles */
function createDiff(classified: ClassifiedFile[]): ParsedDiff {
  return {
    files: classified.map((cf) => cf.file),
  };
}

// ============================================================================
// calculateDiffMetrics tests
// ============================================================================

describe("calculateDiffMetrics", () => {
  it("calculates file count correctly", () => {
    const classified = createClassifiedFiles(5);
    const diff = createDiff(classified);

    const metrics = calculateDiffMetrics(diff, classified);

    expect(metrics.fileCount).toBe(5);
  });

  it("calculates total lines changed", () => {
    // Each file has 10 adds + 5 deletes = 15 lines
    const classified = createClassifiedFiles(3);
    const diff = createDiff(classified);

    const metrics = calculateDiffMetrics(diff, classified);

    expect(metrics.totalLines).toBe(45); // 3 files * 15 lines
  });

  it("calculates estimated tokens from classified files", () => {
    const classified = createClassifiedFiles(4, 1, 250); // 4 files, 250 tokens each
    const diff = createDiff(classified);

    const metrics = calculateDiffMetrics(diff, classified);

    expect(metrics.estimatedTokens).toBe(1000);
  });

  it("counts tier 1 files correctly", () => {
    const tier1 = createClassifiedFiles(3, 1);
    const tier2 = createClassifiedFiles(2, 2);
    const tier3 = createClassifiedFiles(1, 3);
    const classified = [...tier1, ...tier2, ...tier3];
    const diff = createDiff(classified);

    const metrics = calculateDiffMetrics(diff, classified);

    expect(metrics.tier1FileCount).toBe(3);
  });

  it("handles empty diff", () => {
    const classified: ClassifiedFile[] = [];
    const diff = createDiff(classified);

    const metrics = calculateDiffMetrics(diff, classified);

    expect(metrics).toEqual({
      fileCount: 0,
      totalLines: 0,
      estimatedTokens: 0,
      tier1FileCount: 0,
    });
  });
});

// ============================================================================
// selectStrategy tests
// ============================================================================

describe("selectStrategy", () => {
  describe("direct strategy (small diffs)", () => {
    it("selects direct for ≤15 files", () => {
      const classified = createClassifiedFiles(15);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      const result = selectStrategy(metrics);

      expect(result.strategy).toBe("direct");
      expect(result.reason).toContain("15 files");
    });

    it("selects direct for ≤8k tokens even with more files", () => {
      // 20 files but only 400 tokens each = 8000 total
      const classified = createClassifiedFiles(20, 1, 400);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      const result = selectStrategy(metrics);

      expect(result.strategy).toBe("direct");
      expect(result.reason).toContain("token");
    });

    it("selects direct for 1 file", () => {
      const classified = createClassifiedFiles(1);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      const result = selectStrategy(metrics);

      expect(result.strategy).toBe("direct");
    });
  });

  describe("two-pass strategy (medium diffs)", () => {
    it("selects two-pass for 16-40 files when tokens exceed threshold", () => {
      // 16 files with enough tokens to exceed 8k threshold
      const classified = createClassifiedFiles(16, 1, 600);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      const result = selectStrategy(metrics);

      expect(result.strategy).toBe("two-pass");
      expect(result.reason).toContain("Medium diff");
      expect(result.reason).toContain("16 files");
    });

    it("selects two-pass for exactly 40 files", () => {
      const classified = createClassifiedFiles(40, 1, 600);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      const result = selectStrategy(metrics);

      expect(result.strategy).toBe("two-pass");
    });
  });

  describe("flow-based strategy (large diffs)", () => {
    it("selects flow-based for 41-80 files", () => {
      const classified = createClassifiedFiles(41, 1, 600);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      const result = selectStrategy(metrics);

      expect(result.strategy).toBe("flow-based");
      expect(result.reason).toContain("Large diff");
      expect(result.reason).toContain("41 files");
    });

    it("selects flow-based for exactly 80 files", () => {
      const classified = createClassifiedFiles(80, 1, 600);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      const result = selectStrategy(metrics);

      expect(result.strategy).toBe("flow-based");
    });
  });

  describe("hierarchical strategy (huge diffs)", () => {
    it("selects hierarchical for >80 files", () => {
      const classified = createClassifiedFiles(81, 1, 600);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      const result = selectStrategy(metrics);

      expect(result.strategy).toBe("hierarchical");
      expect(result.reason).toContain("Huge diff");
      expect(result.reason).toContain("81 files");
    });

    it("selects hierarchical for 100+ files", () => {
      const classified = createClassifiedFiles(100, 1, 600);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      const result = selectStrategy(metrics);

      expect(result.strategy).toBe("hierarchical");
    });
  });

  describe("boundary conditions", () => {
    it("boundary: 15 files → direct", () => {
      const classified = createClassifiedFiles(15, 1, 600);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      expect(selectStrategy(metrics).strategy).toBe("direct");
    });

    it("boundary: 16 files with high tokens → two-pass", () => {
      const classified = createClassifiedFiles(16, 1, 600);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      expect(selectStrategy(metrics).strategy).toBe("two-pass");
    });

    it("boundary: 40 files → two-pass", () => {
      const classified = createClassifiedFiles(40, 1, 600);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      expect(selectStrategy(metrics).strategy).toBe("two-pass");
    });

    it("boundary: 41 files → flow-based", () => {
      const classified = createClassifiedFiles(41, 1, 600);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      expect(selectStrategy(metrics).strategy).toBe("flow-based");
    });

    it("boundary: 80 files → flow-based", () => {
      const classified = createClassifiedFiles(80, 1, 600);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      expect(selectStrategy(metrics).strategy).toBe("flow-based");
    });

    it("boundary: 81 files → hierarchical", () => {
      const classified = createClassifiedFiles(81, 1, 600);
      const diff = createDiff(classified);
      const metrics = calculateDiffMetrics(diff, classified);

      expect(selectStrategy(metrics).strategy).toBe("hierarchical");
    });
  });

  it("includes metrics in result", () => {
    const classified = createClassifiedFiles(25, 1, 500);
    const diff = createDiff(classified);
    const metrics = calculateDiffMetrics(diff, classified);

    const result = selectStrategy(metrics);

    expect(result.metrics).toBe(metrics);
    expect(result.metrics.fileCount).toBe(25);
    expect(result.metrics.estimatedTokens).toBe(12500);
  });
});
