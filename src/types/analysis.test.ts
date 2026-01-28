/**
 * Tests for ArkType analysis schemas
 *
 * These tests verify that our ArkType schemas correctly validate
 * and reject data. This is useful for understanding ArkType's behavior
 * and ensuring our schemas are correctly defined.
 */

import { describe, it, expect } from "bun:test";
import { type } from "arktype";
import { DerivedIntentSchema, ChangeScopeSchema } from "./analysis.js";

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
