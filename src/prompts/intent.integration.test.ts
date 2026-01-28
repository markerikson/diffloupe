/**
 * Integration tests for intent derivation (requires ANTHROPIC_API_KEY)
 *
 * Run with: ANTHROPIC_API_KEY=your_key pnpm test src/prompts/intent.integration.test.ts
 *
 * These tests make actual API calls and verify the full pipeline.
 * They're skipped by default if no API key is available.
 */

import { describe, it, expect } from "bun:test";
import { deriveIntent } from "./intent.js";
import { hasAPIKey } from "../services/llm.js";
import type { ParsedDiff } from "../types/diff.js";
import type { ClassifiedFile } from "../types/loader.js";

// Skip all tests if no API key
const describeWithAPI = hasAPIKey() ? describe : describe.skip;

describeWithAPI("deriveIntent (integration)", () => {
  // Helper to create a realistic diff for testing
  function createTestDiff(): { diff: ParsedDiff; classified: ClassifiedFile[] } {
    const file = {
      path: "src/api/rateLimit.ts",
      status: "added" as const,
      isBinary: false,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 25,
          header: "@@ -0,0 +1,25 @@",
          lines: [
            { type: "add" as const, content: "/**", oldLineNumber: undefined, newLineNumber: 1 },
            { type: "add" as const, content: " * Rate limiting middleware for API endpoints", oldLineNumber: undefined, newLineNumber: 2 },
            { type: "add" as const, content: " */", oldLineNumber: undefined, newLineNumber: 3 },
            { type: "add" as const, content: "", oldLineNumber: undefined, newLineNumber: 4 },
            { type: "add" as const, content: "interface RateLimitConfig {", oldLineNumber: undefined, newLineNumber: 5 },
            { type: "add" as const, content: "  windowMs: number;", oldLineNumber: undefined, newLineNumber: 6 },
            { type: "add" as const, content: "  maxRequests: number;", oldLineNumber: undefined, newLineNumber: 7 },
            { type: "add" as const, content: "}", oldLineNumber: undefined, newLineNumber: 8 },
            { type: "add" as const, content: "", oldLineNumber: undefined, newLineNumber: 9 },
            { type: "add" as const, content: "export function createRateLimiter(config: RateLimitConfig) {", oldLineNumber: undefined, newLineNumber: 10 },
            { type: "add" as const, content: "  const requests = new Map<string, number[]>();", oldLineNumber: undefined, newLineNumber: 11 },
            { type: "add" as const, content: "", oldLineNumber: undefined, newLineNumber: 12 },
            { type: "add" as const, content: "  return function rateLimit(clientId: string): boolean {", oldLineNumber: undefined, newLineNumber: 13 },
            { type: "add" as const, content: "    const now = Date.now();", oldLineNumber: undefined, newLineNumber: 14 },
            { type: "add" as const, content: "    const windowStart = now - config.windowMs;", oldLineNumber: undefined, newLineNumber: 15 },
            { type: "add" as const, content: "", oldLineNumber: undefined, newLineNumber: 16 },
            { type: "add" as const, content: "    // Get or initialize request timestamps for this client", oldLineNumber: undefined, newLineNumber: 17 },
            { type: "add" as const, content: "    const timestamps = requests.get(clientId) ?? [];", oldLineNumber: undefined, newLineNumber: 18 },
            { type: "add" as const, content: "", oldLineNumber: undefined, newLineNumber: 19 },
            { type: "add" as const, content: "    // Filter to only recent requests within window", oldLineNumber: undefined, newLineNumber: 20 },
            { type: "add" as const, content: "    const recentRequests = timestamps.filter(t => t > windowStart);", oldLineNumber: undefined, newLineNumber: 21 },
            { type: "add" as const, content: "", oldLineNumber: undefined, newLineNumber: 22 },
            { type: "add" as const, content: "    if (recentRequests.length >= config.maxRequests) {", oldLineNumber: undefined, newLineNumber: 23 },
            { type: "add" as const, content: "      return false; // Rate limited", oldLineNumber: undefined, newLineNumber: 24 },
            { type: "add" as const, content: "    }", oldLineNumber: undefined, newLineNumber: 25 },
          ],
        },
      ],
    };

    return {
      diff: { files: [file] },
      classified: [
        {
          file,
          tier: 1,
          reason: "source code",
          estimatedTokens: 200,
        },
      ],
    };
  }

  it("derives intent from a rate limiting feature diff", async () => {
    const { diff, classified } = createTestDiff();

    const intent = await deriveIntent(diff, classified);

    // Verify structure - ArkType validates this, but we double-check
    expect(intent.summary).toBeTruthy();
    expect(intent.purpose).toBeTruthy();
    expect(intent.scope).toBeDefined();
    expect(intent.affectedAreas).toBeInstanceOf(Array);
    expect(intent.affectedAreas.length).toBeGreaterThan(0);

    // The scope should recognize this as a feature
    expect(["feature", "mixed"]).toContain(intent.scope);

    // Log output for manual inspection
    console.log("\n--- Derived Intent ---");
    console.log("Summary:", intent.summary);
    console.log("Purpose:", intent.purpose);
    console.log("Scope:", intent.scope);
    console.log("Affected Areas:", intent.affectedAreas);
    if (intent.suggestedReviewOrder) {
      console.log("Review Order:", intent.suggestedReviewOrder);
    }
    console.log("---\n");
  }, 30000); // 30s timeout for API call

  it("handles simple bugfix diff", async () => {
    const bugfixFile = {
      path: "src/utils/parseDate.ts",
      status: "modified" as const,
      isBinary: false,
      hunks: [
        {
          oldStart: 10,
          oldLines: 3,
          newStart: 10,
          newLines: 3,
          header: "@@ -10,3 +10,3 @@",
          lines: [
            { type: "context" as const, content: "export function parseDate(input: string): Date {", oldLineNumber: 10, newLineNumber: 10 },
            { type: "delete" as const, content: "  return new Date(input);  // Bug: doesn't handle timezone", oldLineNumber: 11, newLineNumber: undefined },
            { type: "add" as const, content: "  return new Date(input + 'Z');  // Fix: treat as UTC", oldLineNumber: undefined, newLineNumber: 11 },
          ],
        },
      ],
    };

    const diff: ParsedDiff = { files: [bugfixFile] };
    const classified: ClassifiedFile[] = [
      { file: bugfixFile, tier: 1, reason: "source code", estimatedTokens: 50 },
    ];

    const intent = await deriveIntent(diff, classified);

    // Should recognize as bugfix
    expect(["bugfix", "mixed"]).toContain(intent.scope);

    console.log("\n--- Bugfix Intent ---");
    console.log("Summary:", intent.summary);
    console.log("Purpose:", intent.purpose);
    console.log("Scope:", intent.scope);
    console.log("---\n");
  }, 30000);
});
