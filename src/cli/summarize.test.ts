/**
 * Tests for summarize command utilities
 */

import { describe, it, expect } from "bun:test";
import {
  estimateTokens,
  estimateFileTokens,
  estimateDiffTokens,
} from "../utils/token-estimate.js";
import type { DiffFile } from "../types/diff.js";

describe("estimateTokens", () => {
  it("estimates tokens using char/4 heuristic", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("1234")).toBe(1);
    expect(estimateTokens("12345")).toBe(2);
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });

  it("rounds up partial tokens", () => {
    expect(estimateTokens("123")).toBe(1); // 3/4 = 0.75 -> 1
    expect(estimateTokens("12345")).toBe(2); // 5/4 = 1.25 -> 2
  });
});

describe("estimateFileTokens", () => {
  it("returns same tokens for non-deleted files", () => {
    const file: DiffFile = {
      path: "src/test.ts",
      status: "modified",
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          header: "@@ -1,1 +1,1 @@",
          lines: [
            { type: "delete", content: "old line", oldLineNumber: 1, newLineNumber: undefined },
            { type: "add", content: "new line", oldLineNumber: undefined, newLineNumber: 1 },
          ],
        },
      ],
    };

    const estimate = estimateFileTokens(file);

    expect(estimate.summarized).toBe(false);
    expect(estimate.original).toBe(estimate.withSummarization);
  });

  it("returns summarized tokens for large deleted files", () => {
    // Create deleted file with 150 lines
    const lines = Array.from({ length: 150 }, (_, i) => ({
      type: "delete" as const,
      content: `line ${i + 1} with some content here`,
      oldLineNumber: i + 1,
      newLineNumber: undefined,
    }));

    const file: DiffFile = {
      path: "src/deleted.ts",
      status: "deleted",
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 150,
          newStart: 0,
          newLines: 0,
          header: "@@ -1,150 +0,0 @@",
          lines,
        },
      ],
    };

    const estimate = estimateFileTokens(file);

    expect(estimate.summarized).toBe(true);
    expect(estimate.withSummarization).toBeLessThan(estimate.original);
  });

  it("does not summarize small deleted files", () => {
    const file: DiffFile = {
      path: "src/small.ts",
      status: "deleted",
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 10,
          newStart: 0,
          newLines: 0,
          header: "@@ -1,10 +0,0 @@",
          lines: Array.from({ length: 10 }, (_, i) => ({
            type: "delete" as const,
            content: `line ${i + 1}`,
            oldLineNumber: i + 1,
            newLineNumber: undefined,
          })),
        },
      ],
    };

    const estimate = estimateFileTokens(file);

    expect(estimate.summarized).toBe(false);
    expect(estimate.original).toBe(estimate.withSummarization);
  });
});

describe("estimateDiffTokens", () => {
  it("aggregates totals correctly", () => {
    const files: DiffFile[] = [
      {
        path: "a.ts",
        status: "modified",
        isBinary: false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            header: "@@ -1,1 +1,1 @@",
            lines: [
              { type: "context", content: "a".repeat(40), oldLineNumber: 1, newLineNumber: 1 },
            ],
          },
        ],
      },
      {
        path: "b.ts",
        status: "modified",
        isBinary: false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            header: "@@ -1,1 +1,1 @@",
            lines: [
              { type: "context", content: "b".repeat(40), oldLineNumber: 1, newLineNumber: 1 },
            ],
          },
        ],
      },
    ];

    const estimate = estimateDiffTokens(files);

    expect(estimate.files).toHaveLength(2);
    expect(estimate.totals.original).toBe(20); // 40 chars each / 4 = 10 each
    expect(estimate.totals.withSummarization).toBe(20);
    expect(estimate.totals.savings).toBe(0);
    expect(estimate.totals.savingsPercent).toBe(0);
  });

  it("calculates savings when files are summarized", () => {
    // Create a large deleted file that will be summarized
    const largeDeletedFile: DiffFile = {
      path: "deleted.ts",
      status: "deleted",
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 200,
          newStart: 0,
          newLines: 0,
          header: "@@ -1,200 +0,0 @@",
          lines: Array.from({ length: 200 }, (_, i) => ({
            type: "delete" as const,
            content: `// This is line ${i + 1} with enough content to have meaningful tokens`,
            oldLineNumber: i + 1,
            newLineNumber: undefined,
          })),
        },
      ],
    };

    const estimate = estimateDiffTokens([largeDeletedFile]);

    expect(estimate.totals.savings).toBeGreaterThan(0);
    expect(estimate.totals.savingsPercent).toBeGreaterThan(0);
    expect(estimate.totals.withSummarization).toBeLessThan(estimate.totals.original);
  });
});
