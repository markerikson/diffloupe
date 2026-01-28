/**
 * Tests for intent derivation prompt building
 *
 * These tests verify the prompt construction logic.
 * The actual LLM calls and schema validation are tested in integration tests.
 */

import { describe, it, expect } from "bun:test";
import { buildIntentPrompt } from "./intent.js";
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

describe("buildIntentPrompt", () => {
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

    const prompt = buildIntentPrompt(diff, classified);

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

    const prompt = buildIntentPrompt(diff, classified);

    expect(prompt).toContain("Total files changed: 3");
    expect(prompt).toContain("Files included for analysis: 2");
    expect(prompt).toContain("1 files excluded");
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

    const prompt = buildIntentPrompt(diff, classified);

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

    const prompt = buildIntentPrompt(diff, classified);

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

    const prompt = buildIntentPrompt(diff, classified);

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

    const prompt = buildIntentPrompt(diff, classified);

    expect(prompt).toContain("assets/image.png");
    expect(prompt).toContain("[binary file]");
  });

  it("includes task instruction at the end", () => {
    const file = createDiffFile("src/test.ts");
    const diff: ParsedDiff = { files: [file] };
    const classified: ClassifiedFile[] = [classify(file, 1, "source code")];

    const prompt = buildIntentPrompt(diff, classified);

    // The task instruction should be at the end
    expect(prompt).toContain("Analyze this diff");
    expect(prompt).toContain("Focus on WHY, not just WHAT");
  });

  it("handles empty diff gracefully", () => {
    const diff: ParsedDiff = { files: [] };
    const classified: ClassifiedFile[] = [];

    const prompt = buildIntentPrompt(diff, classified);

    expect(prompt).toContain("Total files changed: 0");
    expect(prompt).toContain("Files included for analysis: 0");
  });

  it("includes stated intent when provided", () => {
    const file = createDiffFile("src/auth.ts");
    const diff: ParsedDiff = { files: [file] };
    const classified = [classify(file, 1, "source code")];
    const statedIntent = "Fix null pointer exception in user authentication";

    const prompt = buildIntentPrompt(diff, classified, statedIntent);

    expect(prompt).toContain("## Author's Stated Intent");
    expect(prompt).toContain("Fix null pointer exception in user authentication");
    expect(prompt).toContain("derive intent from the actual code changes");
  });

  it("omits stated intent section when not provided", () => {
    const file = createDiffFile("src/auth.ts");
    const diff: ParsedDiff = { files: [file] };
    const classified = [classify(file, 1, "source code")];

    const prompt = buildIntentPrompt(diff, classified);

    expect(prompt).not.toContain("## Author's Stated Intent");
  });

  it("handles undefined stated intent", () => {
    const file = createDiffFile("src/auth.ts");
    const diff: ParsedDiff = { files: [file] };
    const classified = [classify(file, 1, "source code")];

    const prompt = buildIntentPrompt(diff, classified, undefined);

    expect(prompt).not.toContain("## Author's Stated Intent");
  });

  it("summarizes large deleted files (>100 lines)", () => {
    // Create a deleted file with 150 lines of content
    const deletedLines = [
      'import { createSlice } from "@reduxjs/toolkit";',
      'import type { AuthState } from "./types";',
      "",
      "export interface User {",
      "  id: string;",
      "  name: string;",
      "}",
      "",
      "export function validateToken(token: string): boolean {",
      "  return token.length > 0;",
      "}",
      "",
      "export class AuthService {",
      "  login() {}",
      "}",
    ];
    // Pad to 150 lines
    while (deletedLines.length < 150) {
      deletedLines.push(`// line ${deletedLines.length + 1}`);
    }

    const deletedFile: DiffFile = {
      path: "src/old-auth/legacy-service.ts",
      status: "deleted",
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 150,
          newStart: 0,
          newLines: 0,
          header: "@@ -1,150 +0,0 @@",
          lines: deletedLines.map((line, i) => ({
            type: "delete" as const,
            content: line,
            oldLineNumber: i + 1,
            newLineNumber: undefined,
          })),
        },
      ],
    };

    const diff: ParsedDiff = { files: [deletedFile] };
    const classified = [classify(deletedFile, 1, "source code")];

    const prompt = buildIntentPrompt(diff, classified);

    // Should use summary format, not full diff
    expect(prompt).toContain("DELETED FILE: src/old-auth/legacy-service.ts (150 lines)");
    expect(prompt).toContain("First 15 lines (header/imports):");
    expect(prompt).toContain("Extracted signatures:");
    expect(prompt).toContain("- interface User");
    expect(prompt).toContain("- function validateToken()");
    expect(prompt).toContain("- class AuthService");

    // Should NOT contain the full diff format for this file
    expect(prompt).not.toContain("=== src/old-auth/legacy-service.ts (DELETED) ===");
  });

  it("shows full content for small deleted files (<=100 lines)", () => {
    const deletedLines = [
      'import { foo } from "bar";',
      "",
      "export function helper() {}",
    ];

    const smallDeletedFile: DiffFile = {
      path: "src/utils/small.ts",
      status: "deleted",
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 0,
          newLines: 0,
          header: "@@ -1,3 +0,0 @@",
          lines: deletedLines.map((line, i) => ({
            type: "delete" as const,
            content: line,
            oldLineNumber: i + 1,
            newLineNumber: undefined,
          })),
        },
      ],
    };

    const diff: ParsedDiff = { files: [smallDeletedFile] };
    const classified = [classify(smallDeletedFile, 1, "source code")];

    const prompt = buildIntentPrompt(diff, classified);

    // Should use full diff format
    expect(prompt).toContain("=== src/utils/small.ts (DELETED) ===");
    expect(prompt).toContain('@@ -1,3 +0,0 @@');
    expect(prompt).toContain('-import { foo } from "bar";');

    // Should NOT use summary format
    expect(prompt).not.toContain("DELETED FILE:");
    expect(prompt).not.toContain("Extracted signatures:");
  });
});
