/**
 * Integration tests for risk assessment (requires ANTHROPIC_API_KEY)
 *
 * Run with: ANTHROPIC_API_KEY=your_key pnpm test src/prompts/risks.integration.test.ts
 *
 * These tests make actual API calls and verify the full pipeline.
 * They're skipped by default if no API key is available.
 */

import { describe, it, expect } from "bun:test";
import { assessRisks } from "./risks.js";
import { hasAPIKey } from "../services/llm.js";
import type { ParsedDiff, DiffFile } from "../types/diff.js";
import type { ClassifiedFile } from "../types/loader.js";

// Skip all tests if no API key
const describeWithAPI = hasAPIKey() ? describe : describe.skip;

describeWithAPI("assessRisks (integration)", () => {
  /**
   * Test: Risky auth change - removing password validation
   *
   * This diff removes password complexity validation, which is a clear
   * security risk. The LLM should flag this as high/critical.
   */
  it("identifies security risk in auth code", async () => {
    const authFile: DiffFile = {
      path: "src/auth/validatePassword.ts",
      status: "modified",
      isBinary: false,
      hunks: [
        {
          oldStart: 10,
          oldLines: 15,
          newStart: 10,
          newLines: 5,
          header: "@@ -10,15 +10,5 @@",
          lines: [
            {
              type: "context",
              content: "export function validatePassword(password: string): boolean {",
              oldLineNumber: 10,
              newLineNumber: 10,
            },
            {
              type: "delete",
              content: "  // Check minimum length",
              oldLineNumber: 11,
              newLineNumber: undefined,
            },
            {
              type: "delete",
              content: "  if (password.length < 12) return false;",
              oldLineNumber: 12,
              newLineNumber: undefined,
            },
            {
              type: "delete",
              content: "  // Check for uppercase",
              oldLineNumber: 13,
              newLineNumber: undefined,
            },
            {
              type: "delete",
              content: "  if (!/[A-Z]/.test(password)) return false;",
              oldLineNumber: 14,
              newLineNumber: undefined,
            },
            {
              type: "delete",
              content: "  // Check for special characters",
              oldLineNumber: 15,
              newLineNumber: undefined,
            },
            {
              type: "delete",
              content: "  if (!/[!@#$%^&*]/.test(password)) return false;",
              oldLineNumber: 16,
              newLineNumber: undefined,
            },
            {
              type: "delete",
              content: "",
              oldLineNumber: 17,
              newLineNumber: undefined,
            },
            {
              type: "add",
              content: "  // Simplified validation",
              oldLineNumber: undefined,
              newLineNumber: 11,
            },
            {
              type: "add",
              content: "  return password.length > 0;",
              oldLineNumber: undefined,
              newLineNumber: 12,
            },
            {
              type: "context",
              content: "}",
              oldLineNumber: 18,
              newLineNumber: 13,
            },
          ],
        },
      ],
    };

    const diff: ParsedDiff = { files: [authFile] };
    const classified: ClassifiedFile[] = [
      { file: authFile, tier: 1, reason: "source code", estimatedTokens: 150 },
    ];

    const assessment = await assessRisks(diff, classified);

    // Should identify at least one risk
    expect(assessment.risks.length).toBeGreaterThan(0);

    // Overall risk should be high or critical for removing security validation
    expect(["high", "critical"]).toContain(assessment.overallRisk);

    // Should have a security-related risk
    const securityRisk = assessment.risks.find(
      (r) => r.category === "security" || r.description.toLowerCase().includes("security")
    );
    expect(securityRisk).toBeDefined();

    // Log for manual inspection
    console.log("\n--- Auth Risk Assessment ---");
    console.log("Overall Risk:", assessment.overallRisk);
    console.log("Summary:", assessment.summary);
    console.log("Confidence:", assessment.confidence);
    console.log("Risks:");
    for (const risk of assessment.risks) {
      console.log(`  [${risk.severity}] ${risk.category}: ${risk.description}`);
      console.log(`    Evidence: ${risk.evidence}`);
      if (risk.mitigation) {
        console.log(`    Mitigation: ${risk.mitigation}`);
      }
    }
    console.log("---\n");
  }, 30000);

  /**
   * Test: Breaking API change - removing exported function
   *
   * This diff removes an exported function, which is a breaking change
   * for any consumers of this module.
   */
  it("identifies breaking change when removing export", async () => {
    const apiFile: DiffFile = {
      path: "src/utils/index.ts",
      status: "modified",
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 10,
          newStart: 1,
          newLines: 5,
          header: "@@ -1,10 +1,5 @@",
          lines: [
            {
              type: "context",
              content: "export { formatDate } from './date.js';",
              oldLineNumber: 1,
              newLineNumber: 1,
            },
            {
              type: "context",
              content: "export { parseJSON } from './json.js';",
              oldLineNumber: 2,
              newLineNumber: 2,
            },
            {
              type: "delete",
              content: "export { validateEmail } from './email.js';  // Used by 15+ consumers",
              oldLineNumber: 3,
              newLineNumber: undefined,
            },
            {
              type: "delete",
              content: "export { normalizePhone } from './phone.js';",
              oldLineNumber: 4,
              newLineNumber: undefined,
            },
            {
              type: "context",
              content: "",
              oldLineNumber: 5,
              newLineNumber: 3,
            },
            {
              type: "context",
              content: "// Types",
              oldLineNumber: 6,
              newLineNumber: 4,
            },
            {
              type: "context",
              content: "export type { DateFormat } from './date.js';",
              oldLineNumber: 7,
              newLineNumber: 5,
            },
          ],
        },
      ],
    };

    const diff: ParsedDiff = { files: [apiFile] };
    const classified: ClassifiedFile[] = [
      { file: apiFile, tier: 1, reason: "source code", estimatedTokens: 100 },
    ];

    const assessment = await assessRisks(diff, classified);

    // Should identify at least one risk
    expect(assessment.risks.length).toBeGreaterThan(0);

    // Should find a breaking change risk
    const breakingRisk = assessment.risks.find(
      (r) =>
        r.category === "breaking-change" ||
        r.description.toLowerCase().includes("breaking") ||
        r.description.toLowerCase().includes("removed export")
    );
    expect(breakingRisk).toBeDefined();

    console.log("\n--- Breaking Change Assessment ---");
    console.log("Overall Risk:", assessment.overallRisk);
    console.log("Summary:", assessment.summary);
    console.log("Risks:");
    for (const risk of assessment.risks) {
      console.log(`  [${risk.severity}] ${risk.category}: ${risk.description}`);
    }
    console.log("---\n");
  }, 30000);

  /**
   * Test: Safe refactor - no real risks
   *
   * This diff is a simple rename refactor with no functional changes.
   * The LLM should recognize this as low risk.
   */
  it("recognizes safe refactor as low risk", async () => {
    const refactorFile: DiffFile = {
      path: "src/components/Button.tsx",
      status: "modified",
      isBinary: false,
      hunks: [
        {
          oldStart: 5,
          oldLines: 6,
          newStart: 5,
          newLines: 6,
          header: "@@ -5,6 +5,6 @@",
          lines: [
            {
              type: "context",
              content: "interface ButtonProps {",
              oldLineNumber: 5,
              newLineNumber: 5,
            },
            {
              type: "delete",
              content: "  btnText: string;",
              oldLineNumber: 6,
              newLineNumber: undefined,
            },
            {
              type: "add",
              content: "  label: string;  // Renamed for clarity",
              oldLineNumber: undefined,
              newLineNumber: 6,
            },
            {
              type: "context",
              content: "  onClick: () => void;",
              oldLineNumber: 7,
              newLineNumber: 7,
            },
            {
              type: "context",
              content: "}",
              oldLineNumber: 8,
              newLineNumber: 8,
            },
            {
              type: "context",
              content: "",
              oldLineNumber: 9,
              newLineNumber: 9,
            },
            {
              type: "delete",
              content: "export function Button({ btnText, onClick }: ButtonProps) {",
              oldLineNumber: 10,
              newLineNumber: undefined,
            },
            {
              type: "add",
              content: "export function Button({ label, onClick }: ButtonProps) {",
              oldLineNumber: undefined,
              newLineNumber: 10,
            },
          ],
        },
        {
          oldStart: 12,
          oldLines: 3,
          newStart: 12,
          newLines: 3,
          header: "@@ -12,3 +12,3 @@",
          lines: [
            {
              type: "context",
              content: "  return (",
              oldLineNumber: 12,
              newLineNumber: 12,
            },
            {
              type: "delete",
              content: "    <button onClick={onClick}>{btnText}</button>",
              oldLineNumber: 13,
              newLineNumber: undefined,
            },
            {
              type: "add",
              content: "    <button onClick={onClick}>{label}</button>",
              oldLineNumber: undefined,
              newLineNumber: 13,
            },
            {
              type: "context",
              content: "  );",
              oldLineNumber: 14,
              newLineNumber: 14,
            },
          ],
        },
      ],
    };

    const diff: ParsedDiff = { files: [refactorFile] };
    const classified: ClassifiedFile[] = [
      { file: refactorFile, tier: 1, reason: "source code", estimatedTokens: 80 },
    ];

    const assessment = await assessRisks(diff, classified);

    // Overall risk should be low or medium at most (prop rename might break callers)
    // Note: A prop rename IS technically a breaking change for external callers,
    // so the LLM might correctly flag it. We just check it's not critical.
    expect(assessment.overallRisk).not.toBe("critical");

    // Confidence should be reasonable
    expect(["high", "medium"]).toContain(assessment.confidence);

    console.log("\n--- Refactor Assessment ---");
    console.log("Overall Risk:", assessment.overallRisk);
    console.log("Summary:", assessment.summary);
    console.log("Confidence:", assessment.confidence);
    console.log("Risks found:", assessment.risks.length);
    for (const risk of assessment.risks) {
      console.log(`  [${risk.severity}] ${risk.category}: ${risk.description}`);
    }
    console.log("---\n");
  }, 30000);

  /**
   * Test: Error handling gap - missing catch
   *
   * This diff adds async code without proper error handling.
   */
  it("identifies error handling gaps", async () => {
    const asyncFile: DiffFile = {
      path: "src/api/fetchUser.ts",
      status: "modified",
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 8,
          newStart: 1,
          newLines: 12,
          header: "@@ -1,8 +1,12 @@",
          lines: [
            {
              type: "context",
              content: "export async function fetchUser(id: string) {",
              oldLineNumber: 1,
              newLineNumber: 1,
            },
            {
              type: "delete",
              content: "  const response = await fetch(`/api/users/${id}`);",
              oldLineNumber: 2,
              newLineNumber: undefined,
            },
            {
              type: "delete",
              content: "  if (!response.ok) {",
              oldLineNumber: 3,
              newLineNumber: undefined,
            },
            {
              type: "delete",
              content: "    throw new Error(`Failed to fetch user: ${response.status}`);",
              oldLineNumber: 4,
              newLineNumber: undefined,
            },
            {
              type: "delete",
              content: "  }",
              oldLineNumber: 5,
              newLineNumber: undefined,
            },
            {
              type: "add",
              content: "  // Fetch user and their settings in parallel",
              oldLineNumber: undefined,
              newLineNumber: 2,
            },
            {
              type: "add",
              content: "  const [userResponse, settingsResponse] = await Promise.all([",
              oldLineNumber: undefined,
              newLineNumber: 3,
            },
            {
              type: "add",
              content: "    fetch(`/api/users/${id}`),",
              oldLineNumber: undefined,
              newLineNumber: 4,
            },
            {
              type: "add",
              content: "    fetch(`/api/users/${id}/settings`)",
              oldLineNumber: undefined,
              newLineNumber: 5,
            },
            {
              type: "add",
              content: "  ]);",
              oldLineNumber: undefined,
              newLineNumber: 6,
            },
            {
              type: "add",
              content: "",
              oldLineNumber: undefined,
              newLineNumber: 7,
            },
            {
              type: "context",
              content: "  const user = await userResponse.json();",
              oldLineNumber: 6,
              newLineNumber: 8,
            },
            {
              type: "add",
              content: "  const settings = await settingsResponse.json();",
              oldLineNumber: undefined,
              newLineNumber: 9,
            },
            {
              type: "delete",
              content: "  return user;",
              oldLineNumber: 7,
              newLineNumber: undefined,
            },
            {
              type: "add",
              content: "  return { ...user, settings };",
              oldLineNumber: undefined,
              newLineNumber: 10,
            },
            {
              type: "context",
              content: "}",
              oldLineNumber: 8,
              newLineNumber: 11,
            },
          ],
        },
      ],
    };

    const diff: ParsedDiff = { files: [asyncFile] };
    const classified: ClassifiedFile[] = [
      { file: asyncFile, tier: 1, reason: "source code", estimatedTokens: 120 },
    ];

    const assessment = await assessRisks(diff, classified);

    // Should find at least one risk (error handling or API change)
    expect(assessment.risks.length).toBeGreaterThan(0);

    console.log("\n--- Error Handling Assessment ---");
    console.log("Overall Risk:", assessment.overallRisk);
    console.log("Summary:", assessment.summary);
    console.log("Risks:");
    for (const risk of assessment.risks) {
      console.log(`  [${risk.severity}] ${risk.category}: ${risk.description}`);
      console.log(`    Evidence: ${risk.evidence}`);
    }
    console.log("---\n");
  }, 30000);
});
