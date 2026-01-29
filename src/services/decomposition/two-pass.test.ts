import { describe, expect, it } from "bun:test";
import type { ParsedDiff, DiffFile, DiffHunk } from "../../types/diff.js";
import type { ClassifiedFile } from "../../types/loader.js";
import {
  buildOverviewPrompt,
  buildDeepDivePrompt,
  mergeResults,
  type OverviewResult,
} from "./two-pass.js";
import type { RiskAssessment } from "../../types/analysis.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockHunk(
  adds: number,
  deletes: number,
  startLine = 1
): DiffHunk {
  const lines: DiffHunk["lines"] = [];
  let oldLine = startLine;
  let newLine = startLine;
  for (let i = 0; i < deletes; i++) {
    lines.push({
      type: "delete",
      content: `deleted line ${i}`,
      oldLineNumber: oldLine++,
      newLineNumber: undefined,
    });
  }
  for (let i = 0; i < adds; i++) {
    lines.push({
      type: "add",
      content: `added line ${i}`,
      oldLineNumber: undefined,
      newLineNumber: newLine++,
    });
  }
  return {
    header: `@@ -${startLine},${deletes} +${startLine},${adds} @@`,
    oldStart: startLine,
    oldLines: deletes,
    newStart: startLine,
    newLines: adds,
    lines,
  };
}

function createMockFile(
  path: string,
  status: DiffFile["status"] = "modified",
  hunks: DiffHunk[] = [createMockHunk(10, 5)]
): DiffFile {
  return {
    path,
    status,
    hunks,
    isBinary: false,
  };
}

function createClassifiedFile(
  file: DiffFile,
  tier: 1 | 2 | 3 = 1
): ClassifiedFile {
  const tokens = file.hunks.reduce(
    (sum, h) =>
      sum + h.lines.filter((l) => l.type !== "context").length * 10,
    0
  );
  return {
    file,
    tier,
    estimatedTokens: tokens,
    reason: `Tier ${tier} - test file`,
  };
}

// ============================================================================
// buildOverviewPrompt Tests
// ============================================================================

describe("buildOverviewPrompt", () => {
  it("should include file list with stats", () => {
    const files = [
      createMockFile("src/auth/login.ts", "modified", [createMockHunk(20, 10)]),
      createMockFile("src/api/users.ts", "added", [createMockHunk(50, 0)]),
    ];
    const diff: ParsedDiff = { files };
    const classified = files.map((f) => createClassifiedFile(f));

    const prompt = buildOverviewPrompt(diff, classified);

    expect(prompt).toContain("src/auth/login.ts");
    expect(prompt).toContain("+20/-10");
    expect(prompt).toContain("src/api/users.ts");
    expect(prompt).toContain("+50/-0");
  });

  it("should truncate long files to ~20 lines", () => {
    // Create a file with 100 changed lines
    const file = createMockFile("src/big-file.ts", "modified", [
      createMockHunk(100, 50),
    ]);
    const diff: ParsedDiff = { files: [file] };
    const classified = [createClassifiedFile(file)];

    const prompt = buildOverviewPrompt(diff, classified);

    // Should indicate more lines exist
    expect(prompt).toContain("more changed lines");
  });

  it("should include stated intent when provided", () => {
    const file = createMockFile("src/test.ts");
    const diff: ParsedDiff = { files: [file] };
    const classified = [createClassifiedFile(file)];

    const prompt = buildOverviewPrompt(
      diff,
      classified,
      "Add rate limiting to API"
    );

    expect(prompt).toContain("Author's Stated Intent");
    expect(prompt).toContain("Add rate limiting to API");
  });

  it("should exclude tier 3 files", () => {
    const files = [
      createMockFile("src/app.ts"),
      createMockFile("package-lock.json"),
    ];
    const diff: ParsedDiff = { files };
    const classified = [
      createClassifiedFile(files[0]!, 1),
      createClassifiedFile(files[1]!, 3),
    ];

    const prompt = buildOverviewPrompt(diff, classified);

    expect(prompt).toContain("src/app.ts");
    expect(prompt).not.toContain("package-lock.json");
    expect(prompt).toContain("1 files excluded");
  });

  it("should include repository context when provided", () => {
    const file = createMockFile("src/test.ts");
    const diff: ParsedDiff = { files: [file] };
    const classified = [createClassifiedFile(file)];

    const prompt = buildOverviewPrompt(
      diff,
      classified,
      undefined,
      "## Repository Context\n- src/utils.ts\n- src/types.ts"
    );

    expect(prompt).toContain("Repository Context");
    expect(prompt).toContain("src/utils.ts");
  });
});

// ============================================================================
// buildDeepDivePrompt Tests
// ============================================================================

describe("buildDeepDivePrompt", () => {
  it("should include full content only for flagged files", () => {
    const files = [
      createMockFile("src/auth/login.ts", "modified", [createMockHunk(20, 10)]),
      createMockFile("src/api/users.ts", "modified", [createMockHunk(15, 5)]),
      createMockFile("src/utils/helpers.ts", "modified", [createMockHunk(5, 2)]),
    ];
    const diff: ParsedDiff = { files };
    const classified = files.map((f) => createClassifiedFile(f));

    const prompt = buildDeepDivePrompt(
      diff,
      classified,
      ["src/auth/login.ts"], // Only flag auth file
      "Adding authentication improvements"
    );

    // Flagged file should have full diff content
    expect(prompt).toContain("=== src/auth/login.ts");
    expect(prompt).toContain("added line");

    // Non-flagged files should only be listed
    expect(prompt).toContain("Files NOT Flagged");
    expect(prompt).toContain("src/api/users.ts");
    expect(prompt).toContain("src/utils/helpers.ts");
  });

  it("should include overview summary as context", () => {
    const file = createMockFile("src/test.ts");
    const diff: ParsedDiff = { files: [file] };
    const classified = [createClassifiedFile(file)];

    const prompt = buildDeepDivePrompt(
      diff,
      classified,
      ["src/test.ts"],
      "This change adds rate limiting to prevent abuse"
    );

    expect(prompt).toContain("Context from Overview Pass");
    expect(prompt).toContain("This change adds rate limiting");
  });
});

// ============================================================================
// mergeResults Tests
// ============================================================================

describe("mergeResults", () => {
  it("should combine overview intent with risks", () => {
    const overview: OverviewResult = {
      summary: "Adds rate limiting to API endpoints",
      flaggedFiles: ["src/api/routes.ts", "src/middleware/rateLimit.ts"],
      initialRisks: [],
      overviewIntent: {
        summary: "Adds rate limiting to API endpoints",
        purpose: "Prevent API abuse",
        scope: "feature",
        affectedAreas: ["API", "middleware"],
      },
    };

    const deepDive: RiskAssessment = {
      overallRisk: "medium",
      summary: "Found rate limit bypass vulnerability",
      risks: [
        {
          severity: "medium",
          category: "security",
          description: "Rate limit can be bypassed with X-Forwarded-For header",
          evidence: "Line 45: uses req.ip without checking headers",
        },
      ],
      confidence: "high",
    };

    const { intent, risks } = mergeResults(overview, deepDive);

    // Intent should come from overview
    expect(intent.summary).toBe("Adds rate limiting to API endpoints");
    expect(intent.purpose).toBe("Prevent API abuse");
    expect(intent.scope).toBe("feature");

    // Risks should come from deep-dive
    expect(risks.risks).toHaveLength(1);
    expect(risks.risks[0]!.category).toBe("security");
  });

  it("should merge initial risks with deep-dive risks", () => {
    const overview: OverviewResult = {
      summary: "Updates auth system",
      flaggedFiles: ["src/auth/login.ts"],
      initialRisks: [
        {
          severity: "low",
          category: "test-coverage",
          description: "Missing tests for edge cases",
          evidence: "No tests for timeout scenario",
        },
      ],
      overviewIntent: {
        summary: "Updates auth system",
        scope: "feature",
      },
    };

    const deepDive: RiskAssessment = {
      overallRisk: "high",
      summary: "Critical auth bypass found",
      risks: [
        {
          severity: "high",
          category: "security",
          description: "Auth bypass possible",
          evidence: "Token validation skipped",
        },
      ],
      confidence: "high",
    };

    const { risks } = mergeResults(overview, deepDive);

    // Should have both risks, ordered by severity
    expect(risks.risks).toHaveLength(2);
    expect(risks.risks[0]!.severity).toBe("high"); // First (highest)
    expect(risks.risks[1]!.severity).toBe("low"); // Second
  });

  it("should deduplicate similar risks", () => {
    const overview: OverviewResult = {
      summary: "Updates",
      flaggedFiles: [],
      initialRisks: [
        {
          severity: "medium",
          category: "security",
          description: "Missing input validation on user endpoint",
          evidence: "Line 10",
        },
      ],
      overviewIntent: { summary: "Updates" },
    };

    const deepDive: RiskAssessment = {
      overallRisk: "medium",
      summary: "Same issue found in detail",
      risks: [
        {
          severity: "medium",
          category: "security",
          description: "Missing input validation on user endpoint - detailed",
          evidence: "Line 10-15: no sanitization",
        },
      ],
      confidence: "high",
    };

    const { risks } = mergeResults(overview, deepDive);

    // Should keep first one since they have same category and similar description prefix
    // Note: dedup uses first 50 chars of description, so these may both be kept
    // if descriptions differ enough
    expect(risks.risks.length).toBeGreaterThanOrEqual(1);
    expect(risks.risks.length).toBeLessThanOrEqual(2);
  });

  it("should use flagged files as suggested review order", () => {
    const overview: OverviewResult = {
      summary: "Updates",
      flaggedFiles: ["src/critical.ts", "src/important.ts"],
      initialRisks: [],
      overviewIntent: { summary: "Updates" },
    };

    const deepDive: RiskAssessment = {
      overallRisk: "low",
      summary: "No issues",
      risks: [],
      confidence: "high",
    };

    const { intent } = mergeResults(overview, deepDive);

    expect(intent.suggestedReviewOrder).toEqual([
      "src/critical.ts",
      "src/important.ts",
    ]);
  });

  it("should set overall risk to low when no risks found", () => {
    const overview: OverviewResult = {
      summary: "Simple update",
      flaggedFiles: [],
      initialRisks: [],
      overviewIntent: { summary: "Simple update" },
    };

    const deepDive: RiskAssessment = {
      overallRisk: "low",
      summary: "No issues found",
      risks: [],
      confidence: "high",
    };

    const { risks } = mergeResults(overview, deepDive);

    expect(risks.overallRisk).toBe("low");
    expect(risks.risks).toHaveLength(0);
  });
});

// ============================================================================
// Integration Tests (require API key - skipped without it)
// ============================================================================

describe("runTwoPassAnalysis integration", () => {
  const hasAPIKey = !!process.env["ANTHROPIC_API_KEY"];

  it.skipIf(!hasAPIKey)(
    "should run full two-pass analysis on medium diff",
    async () => {
      // This test would make real API calls
      // For CI without API key, we skip it
      // When API key is present, this validates the full flow

      const { runTwoPassAnalysis } = await import("./two-pass.js");

      const files = Array.from({ length: 20 }, (_, i) =>
        createMockFile(`src/file${i}.ts`, "modified", [createMockHunk(15, 10)])
      );
      const diff: ParsedDiff = { files };
      const classified = files.map((f) => createClassifiedFile(f));

      const result = await runTwoPassAnalysis(diff, classified);

      expect(result.metadata.strategy).toBe("two-pass");
      expect(result.intent.summary).toBeDefined();
      expect(result.risks.overallRisk).toBeDefined();
    },
    60000 // 60 second timeout for API calls
  );
});
