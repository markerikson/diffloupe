import { describe, expect, it } from "bun:test";
import type { ParsedDiff, DiffFile, DiffHunk } from "../../types/diff.js";
import type { ClassifiedFile } from "../../types/loader.js";
import type { DerivedIntent, RiskAssessment } from "../../types/analysis.js";
import {
  filterDiffForFlow,
  filterClassifiedForFlow,
  buildSynthesisPrompt,
  type FlowAnalysisResult,
} from "./flow-analysis.js";
import type { DetectedFlow } from "./flow-detection.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockHunk(
  adds: number,
  deletes: number,
  content: string[] = []
): DiffHunk {
  const lines: DiffHunk["lines"] = [];
  let oldLine = 1;
  let newLine = 1;

  for (let i = 0; i < deletes; i++) {
    lines.push({
      type: "delete",
      content: content[i] ?? `deleted line ${i}`,
      oldLineNumber: oldLine++,
      newLineNumber: undefined,
    });
  }
  for (let i = 0; i < adds; i++) {
    lines.push({
      type: "add",
      content: content[deletes + i] ?? `added line ${i}`,
      oldLineNumber: undefined,
      newLineNumber: newLine++,
    });
  }

  return {
    header: `@@ -1,${deletes} +1,${adds} @@`,
    oldStart: 1,
    oldLines: deletes,
    newStart: 1,
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

function createMockFlow(
  name: string,
  files: string[],
  priority: number = 1
): DetectedFlow {
  return {
    name,
    description: `${name} related changes`,
    files,
    priority,
  };
}

function createMockIntent(summary: string): DerivedIntent {
  return {
    summary,
    purpose: `Purpose for: ${summary}`,
    scope: "feature",
    affectedAreas: ["Area 1", "Area 2"],
  };
}

function createMockRisks(
  overallRisk: "low" | "medium" | "high" | "critical"
): RiskAssessment {
  return {
    overallRisk,
    summary: `Risk summary: ${overallRisk}`,
    risks:
      overallRisk === "low"
        ? []
        : [
            {
              severity: overallRisk,
              category: "security",
              description: `A ${overallRisk} risk`,
              evidence: "Some evidence",
            },
          ],
    confidence: "high",
  };
}

// ============================================================================
// filterDiffForFlow Tests
// ============================================================================

describe("filterDiffForFlow", () => {
  it("should filter diff to only include files in the flow", () => {
    const files = [
      createMockFile("src/auth/login.ts"),
      createMockFile("src/auth/logout.ts"),
      createMockFile("src/api/users.ts"),
      createMockFile("src/db/models.ts"),
    ];
    const diff: ParsedDiff = { files };

    const flow = createMockFlow("Authentication", [
      "src/auth/login.ts",
      "src/auth/logout.ts",
    ]);

    const filtered = filterDiffForFlow(diff, flow);

    expect(filtered.files).toHaveLength(2);
    expect(filtered.files.map((f) => f.path)).toEqual([
      "src/auth/login.ts",
      "src/auth/logout.ts",
    ]);
  });

  it("should return empty diff for flow with no matching files", () => {
    const files = [createMockFile("src/other.ts")];
    const diff: ParsedDiff = { files };

    const flow = createMockFlow("Empty", ["src/nonexistent.ts"]);

    const filtered = filterDiffForFlow(diff, flow);

    expect(filtered.files).toHaveLength(0);
  });

  it("should preserve file content when filtering", () => {
    const hunk = createMockHunk(5, 3, [
      "deleted 1",
      "deleted 2",
      "deleted 3",
      "added 1",
      "added 2",
      "added 3",
      "added 4",
      "added 5",
    ]);
    const file = createMockFile("src/important.ts", "modified", [hunk]);
    const diff: ParsedDiff = { files: [file] };

    const flow = createMockFlow("Test", ["src/important.ts"]);

    const filtered = filterDiffForFlow(diff, flow);

    expect(filtered.files[0]).toBe(file);
    expect(filtered.files[0]!.hunks[0]!.lines).toHaveLength(8);
  });
});

// ============================================================================
// filterClassifiedForFlow Tests
// ============================================================================

describe("filterClassifiedForFlow", () => {
  it("should filter classified files to only those in the flow", () => {
    const files = [
      createMockFile("src/auth/login.ts"),
      createMockFile("src/auth/logout.ts"),
      createMockFile("src/api/users.ts"),
    ];
    const classified = files.map((f) => createClassifiedFile(f));

    const flow = createMockFlow("Authentication", [
      "src/auth/login.ts",
      "src/auth/logout.ts",
    ]);

    const filtered = filterClassifiedForFlow(classified, flow);

    expect(filtered).toHaveLength(2);
    expect(filtered.map((cf) => cf.file.path)).toEqual([
      "src/auth/login.ts",
      "src/auth/logout.ts",
    ]);
  });

  it("should preserve tier and token information", () => {
    const file = createMockFile("src/auth/login.ts", "modified", [
      createMockHunk(20, 10),
    ]);
    const classified = [createClassifiedFile(file, 1)];

    const flow = createMockFlow("Auth", ["src/auth/login.ts"]);

    const filtered = filterClassifiedForFlow(classified, flow);

    expect(filtered[0]!.tier).toBe(1);
    expect(filtered[0]!.estimatedTokens).toBe(classified[0]!.estimatedTokens);
  });
});

// ============================================================================
// buildSynthesisPrompt Tests
// ============================================================================

describe("buildSynthesisPrompt", () => {
  it("should include all flow summaries", () => {
    const flowResults: FlowAnalysisResult[] = [
      {
        flow: createMockFlow("Authentication", ["src/auth/login.ts"], 1),
        intent: createMockIntent("Adds login functionality"),
        risks: createMockRisks("low"),
      },
      {
        flow: createMockFlow("Data Layer", ["src/db/models.ts"], 2),
        intent: createMockIntent("Updates database schema"),
        risks: createMockRisks("medium"),
      },
    ];

    const prompt = buildSynthesisPrompt(flowResults);

    expect(prompt).toContain("Authentication");
    expect(prompt).toContain("Data Layer");
    expect(prompt).toContain("Adds login functionality");
    expect(prompt).toContain("Updates database schema");
  });

  it("should include risk information for each flow", () => {
    const flowResults: FlowAnalysisResult[] = [
      {
        flow: createMockFlow("Security", ["src/auth.ts"], 1),
        intent: createMockIntent("Security updates"),
        risks: createMockRisks("high"),
      },
    ];

    const prompt = buildSynthesisPrompt(flowResults);

    expect(prompt).toContain("high");
    expect(prompt).toContain("security");
    expect(prompt).toContain("A high risk");
  });

  it("should include stated intent when provided", () => {
    const flowResults: FlowAnalysisResult[] = [
      {
        flow: createMockFlow("Test", ["test.ts"], 1),
        intent: createMockIntent("Test changes"),
        risks: createMockRisks("low"),
      },
    ];

    const prompt = buildSynthesisPrompt(
      flowResults,
      "This PR adds new authentication features"
    );

    expect(prompt).toContain("Author's Stated Intent");
    expect(prompt).toContain("This PR adds new authentication features");
  });

  it("should include flow counts and total files", () => {
    const flowResults: FlowAnalysisResult[] = [
      {
        flow: createMockFlow("Flow1", ["a.ts", "b.ts"], 1),
        intent: createMockIntent("Flow 1 changes"),
        risks: createMockRisks("low"),
      },
      {
        flow: createMockFlow("Flow2", ["c.ts", "d.ts", "e.ts"], 2),
        intent: createMockIntent("Flow 2 changes"),
        risks: createMockRisks("low"),
      },
    ];

    const prompt = buildSynthesisPrompt(flowResults);

    expect(prompt).toContain("Total flows analyzed: 2");
    expect(prompt).toContain("Total files: 5");
  });

  it("should include output format requirements", () => {
    const flowResults: FlowAnalysisResult[] = [
      {
        flow: createMockFlow("Test", ["test.ts"], 1),
        intent: createMockIntent("Test"),
        risks: createMockRisks("low"),
      },
    ];

    const prompt = buildSynthesisPrompt(flowResults);

    expect(prompt).toContain("summary");
    expect(prompt).toContain("purpose");
    expect(prompt).toContain("scope");
    expect(prompt).toContain("affectedAreas");
    expect(prompt).toContain("overallRisk");
    expect(prompt).toContain("crossFlowConcerns");
  });

  it("should truncate risks to show max 5 per flow", () => {
    const manyRisks: RiskAssessment = {
      overallRisk: "high",
      summary: "Many risks",
      risks: Array.from({ length: 8 }, (_, i) => ({
        severity: "medium" as const,
        category: "test",
        description: `Risk ${i + 1}`,
        evidence: `Evidence ${i + 1}`,
      })),
      confidence: "high",
    };

    const flowResults: FlowAnalysisResult[] = [
      {
        flow: createMockFlow("Risky", ["risky.ts"], 1),
        intent: createMockIntent("Risky changes"),
        risks: manyRisks,
      },
    ];

    const prompt = buildSynthesisPrompt(flowResults);

    // Should show first 5 risks
    expect(prompt).toContain("Risk 1");
    expect(prompt).toContain("Risk 5");
    // Should indicate more
    expect(prompt).toContain("... and 3 more");
    // Should not show all 8
    expect(prompt).not.toContain("Risk 8");
  });
});

// ============================================================================
// Flow Analysis Result Structure Tests
// ============================================================================

describe("FlowAnalysisResult structure", () => {
  it("should have correct shape with flow, intent, and risks", () => {
    const result: FlowAnalysisResult = {
      flow: createMockFlow("Test", ["test.ts"]),
      intent: createMockIntent("Test intent"),
      risks: createMockRisks("low"),
    };

    expect(result.flow).toBeDefined();
    expect(result.flow.name).toBe("Test");
    expect(result.intent).toBeDefined();
    expect(result.intent.summary).toBe("Test intent");
    expect(result.risks).toBeDefined();
    expect(result.risks.overallRisk).toBe("low");
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("Edge cases", () => {
  it("should handle empty flow (no files)", () => {
    const flow = createMockFlow("Empty", []);
    const diff: ParsedDiff = { files: [createMockFile("a.ts")] };
    const classified = [createClassifiedFile(diff.files[0]!)];

    const filteredDiff = filterDiffForFlow(diff, flow);
    const filteredClassified = filterClassifiedForFlow(classified, flow);

    expect(filteredDiff.files).toHaveLength(0);
    expect(filteredClassified).toHaveLength(0);
  });

  it("should handle flow with files not in diff", () => {
    const flow = createMockFlow("Missing", ["nonexistent.ts"]);
    const diff: ParsedDiff = { files: [createMockFile("exists.ts")] };
    const classified = [createClassifiedFile(diff.files[0]!)];

    const filteredDiff = filterDiffForFlow(diff, flow);
    const filteredClassified = filterClassifiedForFlow(classified, flow);

    expect(filteredDiff.files).toHaveLength(0);
    expect(filteredClassified).toHaveLength(0);
  });

  it("should handle flow with partial matches", () => {
    const flow = createMockFlow("Partial", ["a.ts", "missing.ts"]);
    const diff: ParsedDiff = {
      files: [createMockFile("a.ts"), createMockFile("b.ts")],
    };

    const filtered = filterDiffForFlow(diff, flow);

    expect(filtered.files).toHaveLength(1);
    expect(filtered.files[0]!.path).toBe("a.ts");
  });
});

// ============================================================================
// Integration Tests (require API key - skipped without it)
// ============================================================================

describe("runFlowBasedAnalysis integration", () => {
  const hasAPIKey = !!process.env["ANTHROPIC_API_KEY"];

  it.skipIf(!hasAPIKey)(
    "should analyze flows and synthesize results for a realistic diff",
    async () => {
      const { runFlowBasedAnalysis } = await import("./flow-analysis.js");

      // Create a realistic medium-sized diff with clear groupings
      const files: DiffFile[] = [
        // Auth-related (flow 1)
        createMockFile("src/auth/login.ts", "modified", [
          createMockHunk(20, 10, [
            "// Old login logic",
            "async function login(email, password) {",
            "  return await db.users.find(email);",
            "export async function login(email: string, password: string) {",
            "  const hashedPassword = await bcrypt.hash(password);",
            "  return await db.users.findOne({ email, password: hashedPassword });",
          ]),
        ]),
        createMockFile("src/auth/session.ts", "modified", [
          createMockHunk(15, 5, [
            "export function createSession(user) {",
            "export function createSession(user: User): Session {",
            "  return { userId: user.id, token: generateToken() };",
          ]),
        ]),
        // API-related (flow 2)
        createMockFile("src/api/users.ts", "modified", [
          createMockHunk(30, 15, [
            "router.get('/users', getUsers);",
            "router.post('/users', createUser);",
          ]),
        ]),
        createMockFile("src/api/posts.ts", "added", [
          createMockHunk(50, 0, [
            "router.get('/posts', getPosts);",
            "router.post('/posts', createPost);",
          ]),
        ]),
      ];

      const diff: ParsedDiff = { files };
      const classified = files.map((f) => createClassifiedFile(f));

      // Track progress
      const progressCalls: { stage: string; detail: string | undefined }[] = [];

      const result = await runFlowBasedAnalysis(
        diff,
        classified,
        "Add improved authentication and new API endpoints",
        undefined,
        (stage, detail) => {
          progressCalls.push({ stage, detail });
        }
      );

      // Should have detected flows
      expect(result.flows.length).toBeGreaterThan(0);

      // Should have synthesis
      expect(result.synthesis.overallIntent).toBeDefined();
      expect(result.synthesis.overallIntent.summary).toBeTruthy();
      expect(result.synthesis.overallRisks).toBeDefined();

      // Should have metadata
      expect(result.metadata.strategy).toBe("flow-based");
      expect(result.metadata.totalFileCount).toBe(4);
      expect(result.metadata.flowCount).toBeGreaterThan(0);

      // Should have called progress
      expect(progressCalls.some((p) => p.stage === "detecting")).toBe(true);
      expect(progressCalls.some((p) => p.stage === "synthesizing")).toBe(true);

      // Each flow should have valid analysis
      for (const flowResult of result.flows) {
        expect(flowResult.flow.name).toBeTruthy();
        expect(flowResult.intent.summary).toBeTruthy();
        expect(flowResult.risks.overallRisk).toBeTruthy();
      }
    },
    120000 // 2 minute timeout for multiple API calls
  );
});
