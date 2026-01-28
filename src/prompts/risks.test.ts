/**
 * Tests for risk assessment prompt building
 *
 * These tests verify the prompt construction logic.
 * Actual LLM calls and schema validation are tested in integration tests.
 */

import { describe, it, expect } from "bun:test";
import { buildRiskPrompt } from "./risks.js";
import type { ParsedDiff, DiffFile } from "../types/diff.js";
import type { ClassifiedFile } from "../types/loader.js";

// Helper to create a minimal DiffFile
function createDiffFile(
  path: string,
  status: "added" | "modified" | "deleted" | "renamed" = "modified",
  content: string[] = ["+added line", "-removed line", " context"]
): DiffFile {
  return {
    path,
    status,
    isBinary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        header: "@@ -1,3 +1,3 @@",
        lines: content.map((line) => ({
          type:
            line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "delete"
                : "context",
          content: line.slice(1),
          oldLineNumber: line.startsWith("+") ? undefined : 1,
          newLineNumber: line.startsWith("-") ? undefined : 1,
        })),
      },
    ],
  };
}

// Helper to wrap DiffFile in ClassifiedFile
function classify(
  file: DiffFile,
  tier: 1 | 2 | 3,
  reason: string
): ClassifiedFile {
  return {
    file,
    tier,
    reason,
    estimatedTokens: 100,
  };
}

describe("buildRiskPrompt", () => {
  it("includes Tier 1 and Tier 2 files", () => {
    const tier1File = createDiffFile("src/auth.ts");
    const tier2File = createDiffFile("README.md");
    const tier3File = createDiffFile("package-lock.json");

    const diff: ParsedDiff = {
      files: [tier1File, tier2File, tier3File],
    };

    const classified: ClassifiedFile[] = [
      classify(tier1File, 1, "source code"),
      classify(tier2File, 2, "documentation"),
      classify(tier3File, 3, "lock file"),
    ];

    const prompt = buildRiskPrompt(diff, classified);

    // Should include Tier 1 and Tier 2
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("README.md");

    // Should NOT include Tier 3
    expect(prompt).not.toContain("package-lock.json");
  });

  it("includes file overview statistics", () => {
    const file1 = createDiffFile("src/a.ts");
    const file2 = createDiffFile("src/b.ts");
    const lockFile = createDiffFile("yarn.lock");

    const diff: ParsedDiff = {
      files: [file1, file2, lockFile],
    };

    const classified: ClassifiedFile[] = [
      classify(file1, 1, "source code"),
      classify(file2, 1, "source code"),
      classify(lockFile, 3, "lock file"),
    ];

    const prompt = buildRiskPrompt(diff, classified);

    expect(prompt).toContain("Total files changed: 3");
    expect(prompt).toContain("Files included for analysis: 2");
    expect(prompt).toContain("1 files excluded");
  });

  it("notes when test files are in excluded tier", () => {
    const sourceFile = createDiffFile("src/auth.ts");
    const testFile = createDiffFile("src/auth.test.ts");

    const diff: ParsedDiff = {
      files: [sourceFile, testFile],
    };

    // Scenario: test file was classified as Tier 3 (unusual but possible)
    const classified: ClassifiedFile[] = [
      classify(sourceFile, 1, "source code"),
      classify(testFile, 3, "generated test output"),
    ];

    const prompt = buildRiskPrompt(diff, classified);

    // Should note that test files were excluded
    expect(prompt).toContain("test file(s) were in excluded category");
  });

  it("does not mention test exclusion when no tests in tier 3", () => {
    const sourceFile = createDiffFile("src/auth.ts");
    const lockFile = createDiffFile("package-lock.json");

    const diff: ParsedDiff = {
      files: [sourceFile, lockFile],
    };

    const classified: ClassifiedFile[] = [
      classify(sourceFile, 1, "source code"),
      classify(lockFile, 3, "lock file"),
    ];

    const prompt = buildRiskPrompt(diff, classified);

    expect(prompt).not.toContain("test file(s)");
  });

  it("shows file status in file list", () => {
    const addedFile = createDiffFile("src/new.ts", "added");
    const deletedFile = createDiffFile("src/old.ts", "deleted");

    const diff: ParsedDiff = {
      files: [addedFile, deletedFile],
    };

    const classified: ClassifiedFile[] = [
      classify(addedFile, 1, "source code"),
      classify(deletedFile, 1, "source code"),
    ];

    const prompt = buildRiskPrompt(diff, classified);

    expect(prompt).toContain("src/new.ts (added)");
    expect(prompt).toContain("src/old.ts (deleted)");
  });

  it("handles renamed files with old path", () => {
    const renamedFile: DiffFile = {
      ...createDiffFile("src/newName.ts", "renamed"),
      oldPath: "src/oldName.ts",
    };

    const diff: ParsedDiff = {
      files: [renamedFile],
    };

    const classified: ClassifiedFile[] = [
      classify(renamedFile, 1, "source code"),
    ];

    const prompt = buildRiskPrompt(diff, classified);

    expect(prompt).toContain("src/oldName.ts → src/newName.ts (RENAMED)");
  });

  it("includes diff content with proper prefixes", () => {
    const file = createDiffFile("src/test.ts", "modified", [
      "+const added = true;",
      "-const removed = false;",
      " const unchanged = 1;",
    ]);

    const diff: ParsedDiff = { files: [file] };
    const classified: ClassifiedFile[] = [classify(file, 1, "source code")];

    const prompt = buildRiskPrompt(diff, classified);

    // Verify diff line prefixes are preserved
    expect(prompt).toContain("+const added = true;");
    expect(prompt).toContain("-const removed = false;");
    expect(prompt).toContain(" const unchanged = 1;");
  });

  it("handles binary files gracefully", () => {
    const binaryFile: DiffFile = {
      path: "assets/image.png",
      status: "modified",
      isBinary: true,
      hunks: [],
    };

    const diff: ParsedDiff = { files: [binaryFile] };
    const classified: ClassifiedFile[] = [
      { file: binaryFile, tier: 2, reason: "other", estimatedTokens: 10 },
    ];

    const prompt = buildRiskPrompt(diff, classified);

    expect(prompt).toContain("assets/image.png");
    expect(prompt).toContain("[binary file]");
  });

  it("includes risk-specific task instruction at the end", () => {
    const file = createDiffFile("src/test.ts");
    const diff: ParsedDiff = { files: [file] };
    const classified: ClassifiedFile[] = [classify(file, 1, "source code")];

    const prompt = buildRiskPrompt(diff, classified);

    // Should have risk-specific instructions
    expect(prompt).toContain("Analyze this diff for potential risks");
    expect(prompt).toContain("cite SPECIFIC evidence");
    expect(prompt).toContain("empty risks array");
    expect(prompt).toContain("Order risks by severity");
  });

  it("handles empty diff gracefully", () => {
    const diff: ParsedDiff = { files: [] };
    const classified: ClassifiedFile[] = [];

    const prompt = buildRiskPrompt(diff, classified);

    expect(prompt).toContain("Total files changed: 0");
    expect(prompt).toContain("Files included for analysis: 0");
  });

  it("detects spec files as tests in tier 3 warning", () => {
    const sourceFile = createDiffFile("src/auth.ts");
    const specFile = createDiffFile("src/auth.spec.ts");

    const diff: ParsedDiff = {
      files: [sourceFile, specFile],
    };

    const classified: ClassifiedFile[] = [
      classify(sourceFile, 1, "source code"),
      classify(specFile, 3, "test file"),
    ];

    const prompt = buildRiskPrompt(diff, classified);

    // Should detect .spec.ts as test file
    expect(prompt).toContain("test file(s) were in excluded category");
  });
});
