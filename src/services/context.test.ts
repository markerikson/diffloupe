/**
 * Tests for repository context gathering
 */

import { describe, expect, test } from "bun:test";
import {
  getChangedDirectories,
  formatContextSection,
  type SiblingFile,
} from "./context.js";
import type { ParsedDiff, DiffFile } from "../types/diff.js";

// Helper to create a minimal diff file
function makeDiffFile(path: string, oldPath?: string): DiffFile {
  const file: DiffFile = {
    path,
    status: oldPath ? "renamed" : "modified",
    hunks: [],
    isBinary: false,
  };
  if (oldPath) {
    file.oldPath = oldPath;
  }
  return file;
}

// Helper to create a minimal parsed diff
function makeDiff(paths: string[]): ParsedDiff {
  return {
    files: paths.map((p) => makeDiffFile(p)),
  };
}

describe("getChangedDirectories", () => {
  test("extracts directories from file paths", () => {
    const diff = makeDiff([
      "src/services/context.ts",
      "src/prompts/intent.ts",
      "src/prompts/risks.ts",
    ]);

    const dirs = getChangedDirectories(diff);

    expect(dirs).toEqual(["src/prompts", "src/services"]);
  });

  test("deduplicates directories", () => {
    const diff = makeDiff([
      "src/prompts/intent.ts",
      "src/prompts/risks.ts",
      "src/prompts/alignment.ts",
    ]);

    const dirs = getChangedDirectories(diff);

    expect(dirs).toEqual(["src/prompts"]);
  });

  test("includes old path directories for renames", () => {
    const diff: ParsedDiff = {
      files: [
        {
          path: "src/new-dir/file.ts",
          oldPath: "src/old-dir/file.ts",
          status: "renamed",
          hunks: [],
          isBinary: false,
        },
      ],
    };

    const dirs = getChangedDirectories(diff);

    expect(dirs).toEqual(["src/new-dir", "src/old-dir"]);
  });

  test("ignores root-level files", () => {
    const diff = makeDiff(["README.md", "src/index.ts"]);

    const dirs = getChangedDirectories(diff);

    expect(dirs).toEqual(["src"]);
  });

  test("returns empty array for empty diff", () => {
    const diff = makeDiff([]);

    const dirs = getChangedDirectories(diff);

    expect(dirs).toEqual([]);
  });
});

describe("formatContextSection", () => {
  test("formats files grouped by directory", () => {
    const siblings: SiblingFile[] = [
      { path: "src/prompts/intent.ts", status: "existing" },
      { path: "src/prompts/risks.ts", status: "existing" },
      { path: "src/services/git.ts", status: "existing" },
    ];

    const result = formatContextSection(siblings);

    expect(result).toContain("## Repository Context");
    expect(result).toContain("src/prompts/");
    expect(result).toContain("- intent.ts");
    expect(result).toContain("- risks.ts");
    expect(result).toContain("src/services/");
    expect(result).toContain("- git.ts");
  });

  test("marks new files with ← NEW", () => {
    const siblings: SiblingFile[] = [
      { path: "src/prompts/alignment.ts", status: "new" },
      { path: "src/prompts/intent.ts", status: "existing" },
    ];

    const result = formatContextSection(siblings);

    expect(result).toContain("- alignment.ts ← NEW");
    expect(result).toContain("- intent.ts");
    expect(result).not.toContain("intent.ts ←");
  });

  test("marks modified files with ← MODIFIED", () => {
    const siblings: SiblingFile[] = [
      { path: "src/services/git.ts", status: "modified" },
    ];

    const result = formatContextSection(siblings);

    expect(result).toContain("- git.ts ← MODIFIED");
  });

  test("marks deleted files with ← DELETED", () => {
    const siblings: SiblingFile[] = [
      { path: "src/old/deprecated.ts", status: "deleted" },
    ];

    const result = formatContextSection(siblings);

    expect(result).toContain("- deprecated.ts ← DELETED");
  });

  test("returns empty string for no siblings", () => {
    const result = formatContextSection([]);

    expect(result).toBe("");
  });

  test("sorts directories and files", () => {
    const siblings: SiblingFile[] = [
      { path: "src/services/llm.ts", status: "existing" },
      { path: "src/prompts/risks.ts", status: "existing" },
      { path: "src/services/git.ts", status: "existing" },
      { path: "src/prompts/intent.ts", status: "existing" },
    ];

    const result = formatContextSection(siblings);
    const lines = result.split("\n");

    // Find directory lines
    const promptsIndex = lines.findIndex((l) => l === "src/prompts/");
    const servicesIndex = lines.findIndex((l) => l === "src/services/");

    expect(promptsIndex).toBeLessThan(servicesIndex);

    // Check file order within directories
    const intentIndex = lines.findIndex((l) => l.includes("intent.ts"));
    const risksIndex = lines.findIndex((l) => l.includes("risks.ts"));
    expect(intentIndex).toBeLessThan(risksIndex);
  });
});
