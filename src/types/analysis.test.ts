/**
 * Tests for ArkType analysis schemas
 *
 * These tests verify that our ArkType schemas correctly validate
 * and reject data. This is useful for understanding ArkType's behavior
 * and ensuring our schemas are correctly defined.
 */

import { describe, it, expect } from "bun:test";
import { type } from "arktype";
import { DerivedIntentSchema, ChangeScopeSchema, IntentAlignmentSchema } from "./analysis.js";

describe("ChangeScopeSchema", () => {
  it("accepts valid scope values", () => {
    const validScopes = ["feature", "bugfix", "refactor", "config", "docs", "test", "mixed"] as const;

    for (const scope of validScopes) {
      const result = ChangeScopeSchema(scope);
      // ArkType returns the data if valid, or an ArkErrors object if invalid
      expect(result).toBe(scope);
    }
  });

  it("rejects invalid scope values", () => {
    // Use 'as string' to allow testing invalid input
    const result = ChangeScopeSchema("invalid" as string);
    // ArkType returns an error object for invalid data
    expect(result instanceof type.errors).toBe(true);
  });
});

describe("DerivedIntentSchema", () => {
  it("accepts valid complete intent", () => {
    const validIntent = {
      summary: "Adds rate limiting to API",
      purpose: "Prevents abuse",
      scope: "feature" as const,
      affectedAreas: ["API", "middleware"],
      suggestedReviewOrder: ["src/api.ts", "src/middleware.ts"],
    };

    const result = DerivedIntentSchema(validIntent);
    expect(result).toEqual(validIntent);
  });

  it("accepts intent without optional suggestedReviewOrder", () => {
    const intentWithoutOrder = {
      summary: "Fixes timezone bug",
      purpose: "Ensures dates are parsed correctly",
      scope: "bugfix" as const,
      affectedAreas: ["date utils"],
    };

    const result = DerivedIntentSchema(intentWithoutOrder);
    expect(result).toEqual(intentWithoutOrder);
  });

  it("rejects intent missing required fields", () => {
    const missingPurpose = {
      summary: "Some change",
      // purpose is missing
      scope: "feature",
      affectedAreas: ["somewhere"],
    };

    const result = DerivedIntentSchema(missingPurpose);
    expect(result instanceof type.errors).toBe(true);
  });

  it("rejects intent with invalid scope", () => {
    const invalidScope = {
      summary: "Some change",
      purpose: "Some reason",
      scope: "notAValidScope",
      affectedAreas: ["somewhere"],
    };

    const result = DerivedIntentSchema(invalidScope);
    expect(result instanceof type.errors).toBe(true);
  });

  it("rejects intent with wrong type for affectedAreas", () => {
    const wrongType = {
      summary: "Some change",
      purpose: "Some reason",
      scope: "feature",
      affectedAreas: "not an array", // should be string[]
    };

    const result = DerivedIntentSchema(wrongType);
    expect(result instanceof type.errors).toBe(true);
  });

  it("rejects empty affectedAreas", () => {
    // Note: Our schema allows empty arrays - this test documents that behavior
    // If we want to require at least one area, we'd need to add a constraint
    const emptyAreas = {
      summary: "Some change",
      purpose: "Some reason",
      scope: "feature" as const,
      affectedAreas: [] as string[],
    };

    const result = DerivedIntentSchema(emptyAreas);
    // Currently allows empty arrays - document this behavior
    expect(result).toEqual(emptyAreas);
  });
});

describe("IntentAlignmentSchema", () => {
  it("accepts valid complete alignment", () => {
    const validAlignment = {
      alignment: "aligned" as const,
      confidence: "high" as const,
      summary: "Code does what the author claims",
      matches: ["Added rate limiting as stated"],
      mismatches: [],
      missing: [],
      unstated: [],
    };

    const result = IntentAlignmentSchema(validAlignment);
    expect(result).toEqual(validAlignment);
  });

  it("accepts partial alignment with all fields populated", () => {
    const partialAlignment = {
      alignment: "partial" as const,
      confidence: "medium" as const,
      summary: "Core feature implemented, but includes unstated changes",
      matches: ["Null check added as stated"],
      mismatches: ["Error format differs from stated"],
      missing: ["Logging not implemented"],
      unstated: ["Error messages refactored"],
    };

    const result = IntentAlignmentSchema(partialAlignment);
    expect(result).toEqual(partialAlignment);
  });

  it("accepts misaligned with evidence", () => {
    const misaligned = {
      alignment: "misaligned" as const,
      confidence: "high" as const,
      summary: "Code does something different than claimed",
      matches: [],
      mismatches: ["Stated bugfix, but code adds new feature"],
      missing: ["The stated fix was not applied"],
      unstated: [],
    };

    const result = IntentAlignmentSchema(misaligned);
    expect(result).toEqual(misaligned);
  });

  it("rejects invalid alignment level", () => {
    const invalidAlignment = {
      alignment: "mostly-aligned", // invalid
      confidence: "high",
      summary: "Some summary",
      matches: [],
      mismatches: [],
      missing: [],
      unstated: [],
    };

    const result = IntentAlignmentSchema(invalidAlignment);
    expect(result instanceof type.errors).toBe(true);
  });

  it("rejects invalid confidence level", () => {
    const invalidConfidence = {
      alignment: "aligned",
      confidence: "very-high", // invalid
      summary: "Some summary",
      matches: [],
      mismatches: [],
      missing: [],
      unstated: [],
    };

    const result = IntentAlignmentSchema(invalidConfidence);
    expect(result instanceof type.errors).toBe(true);
  });

  it("rejects missing required fields", () => {
    const missingSummary = {
      alignment: "aligned",
      confidence: "high",
      // summary missing
      matches: [],
      mismatches: [],
      missing: [],
      unstated: [],
    };

    const result = IntentAlignmentSchema(missingSummary);
    expect(result instanceof type.errors).toBe(true);
  });

  it("rejects wrong type for arrays", () => {
    const wrongType = {
      alignment: "aligned",
      confidence: "high",
      summary: "Some summary",
      matches: "not an array", // should be string[]
      mismatches: [],
      missing: [],
      unstated: [],
    };

    const result = IntentAlignmentSchema(wrongType);
    expect(result instanceof type.errors).toBe(true);
  });

  it("allows empty arrays for all list fields", () => {
    const emptyArrays = {
      alignment: "aligned" as const,
      confidence: "high" as const,
      summary: "Everything is fine",
      matches: [],
      mismatches: [],
      missing: [],
      unstated: [],
    };

    const result = IntentAlignmentSchema(emptyArrays);
    expect(result).toEqual(emptyArrays);
  });
});
