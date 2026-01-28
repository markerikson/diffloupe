/**
 * Tests for intent alignment prompt building
 *
 * These tests verify the prompt construction logic.
 * Actual LLM calls are tested in integration tests.
 */

import { describe, it, expect } from "bun:test";
import { buildAlignmentPrompt } from "./alignment.js";
import type { ParsedDiff, DiffFile } from "../types/diff.js";
import type { ClassifiedFile } from "../types/loader.js";
import type { DerivedIntent } from "../types/analysis.js";

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

// Helper to create a minimal DerivedIntent
function createDerivedIntent(overrides?: Partial<DerivedIntent>): DerivedIntent {
  return {
    summary: "Adds rate limiting to API endpoints",
    purpose: "Prevents abuse and ensures fair usage",
    scope: "feature",
    affectedAreas: ["API", "middleware"],
    suggestedReviewOrder: ["src/middleware.ts", "src/api.ts"],
    ...overrides,
  };
}

describe("buildAlignmentPrompt", () => {
  it("includes stated intent section", () => {
    const file = createDiffFile("src/api.ts");
    const diff: ParsedDiff = { files: [file] };
    const classified = [classify(file, 1, "source code")];
    const derivedIntent = createDerivedIntent();
    const statedIntent = "Add rate limiting to protect against abuse";

    const prompt = buildAlignmentPrompt(statedIntent, derivedIntent, diff, classified);

    expect(prompt).toContain("## Author's Stated Intent");
    expect(prompt).toContain("Add rate limiting to protect against abuse");
  });

  it("includes derived intent details", () => {
    const file = createDiffFile("src/api.ts");
    const diff: ParsedDiff = { files: [file] };
    const classified = [classify(file, 1, "source code")];
    const derivedIntent = createDerivedIntent({
      summary: "Implements request throttling",
      purpose: "Limit API abuse",
      scope: "feature",
      affectedAreas: ["rate-limiting", "middleware"],
    });
    const statedIntent = "Add rate limiting";

    const prompt = buildAlignmentPrompt(statedIntent, derivedIntent, diff, classified);

    expect(prompt).toContain("## Derived Intent");
    expect(prompt).toContain("Implements request throttling");
    expect(prompt).toContain("Limit API abuse");
    expect(prompt).toContain("feature");
    expect(prompt).toContain("rate-limiting, middleware");
  });

  it("includes diff content for evidence", () => {
    const file = createDiffFile("src/rateLimit.ts", "modified", [
      "+const MAX_REQUESTS = 100;",
      "-// no limit",
      " function checkRate() {",
    ]);
    const diff: ParsedDiff = { files: [file] };
    const classified = [classify(file, 1, "source code")];
    const derivedIntent = createDerivedIntent();
    const statedIntent = "Add rate limiting";

    const prompt = buildAlignmentPrompt(statedIntent, derivedIntent, diff, classified);

    expect(prompt).toContain("## Diff Content");
    expect(prompt).toContain("+const MAX_REQUESTS = 100;");
    expect(prompt).toContain("-// no limit");
  });

  it("excludes Tier 3 files from diff content", () => {
    const sourceFile = createDiffFile("src/api.ts");
    const lockFile = createDiffFile("package-lock.json");
    const diff: ParsedDiff = { files: [sourceFile, lockFile] };
    const classified = [
      classify(sourceFile, 1, "source code"),
      classify(lockFile, 3, "lock file"),
    ];
    const derivedIntent = createDerivedIntent();
    const statedIntent = "Add feature";

    const prompt = buildAlignmentPrompt(statedIntent, derivedIntent, diff, classified);

    expect(prompt).toContain("src/api.ts");
    expect(prompt).not.toContain("package-lock.json");
  });

  it("handles long stated intent", () => {
    const file = createDiffFile("src/api.ts");
    const diff: ParsedDiff = { files: [file] };
    const classified = [classify(file, 1, "source code")];
    const derivedIntent = createDerivedIntent();
    const longIntent = `
This PR adds rate limiting to the API endpoints.

## What it does
- Adds middleware for rate limiting
- Configurable limits per endpoint
- Uses Redis for distributed tracking

## Why
- Prevents API abuse
- Ensures fair usage across tenants
- Required for enterprise customers
    `.trim();

    const prompt = buildAlignmentPrompt(longIntent, derivedIntent, diff, classified);

    expect(prompt).toContain("This PR adds rate limiting");
    expect(prompt).toContain("Uses Redis for distributed tracking");
  });

  it("includes task instruction", () => {
    const file = createDiffFile("src/api.ts");
    const diff: ParsedDiff = { files: [file] };
    const classified = [classify(file, 1, "source code")];
    const derivedIntent = createDerivedIntent();
    const statedIntent = "Add feature";

    const prompt = buildAlignmentPrompt(statedIntent, derivedIntent, diff, classified);

    expect(prompt).toContain("Compare the stated intent against the derived intent");
    expect(prompt).toContain("cite specific evidence");
  });

  it("handles empty diff gracefully", () => {
    const diff: ParsedDiff = { files: [] };
    const classified: ClassifiedFile[] = [];
    const derivedIntent = createDerivedIntent();
    const statedIntent = "Add feature";

    // Should not throw
    const prompt = buildAlignmentPrompt(statedIntent, derivedIntent, diff, classified);

    expect(prompt).toContain("## Author's Stated Intent");
    expect(prompt).toContain("## Derived Intent");
    expect(prompt).toContain("## Diff Content");
  });
});
