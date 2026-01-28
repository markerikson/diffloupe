/**
 * Analysis Types - Type definitions for diff analysis results
 *
 * These types represent the structured output from LLM analysis of diffs.
 * We use ArkType to define runtime-validated schemas that also provide
 * TypeScript types.
 *
 * ## Why ArkType?
 *
 * ArkType is a TypeScript-first validation library that:
 * - Uses string syntax that mirrors TypeScript types
 * - Provides both runtime validation AND type inference
 * - Implements the Standard Schema spec (works with TanStack AI)
 * - Has excellent error messages
 *
 * The syntax `"'a' | 'b'"` defines a union of literal strings,
 * just like in TypeScript but as a runtime-validated schema.
 */

import { type } from "arktype";

/**
 * Schema for the scope/category of a change.
 *
 * Understanding what KIND of change this is helps reviewers:
 * - Set expectations for what to look for
 * - Prioritize their review focus
 * - Know if tests/docs should be expected
 *
 * ArkType syntax: Union of string literals, same as TS union types
 */
export const ChangeScopeSchema = type(
  "'feature' | 'bugfix' | 'refactor' | 'config' | 'docs' | 'test' | 'mixed'"
);

/** TypeScript type extracted from the schema */
export type ChangeScope = typeof ChangeScopeSchema.infer;

/**
 * Schema for the derived intent from analyzing a diff.
 *
 * This represents what the LLM believes the change is trying to accomplish,
 * based solely on analyzing the diff content. In later phases, this can be
 * compared against user-provided intent to flag mismatches.
 *
 * Design note: We separate "summary" (WHAT) from "purpose" (WHY) because
 * reviewers often need both:
 * - Summary: Quick understanding for triage ("adds user auth endpoint")
 * - Purpose: Context for deeper review ("enables SSO integration")
 *
 * ## ArkType Syntax Notes
 *
 * - `"string"` - validates as string type
 * - `"string[]"` - array of strings
 * - `"'a' | 'b'"` - union of literal strings
 * - `"key?"` - optional property (the ? is in the key name)
 */
export const DerivedIntentSchema = type({
  /**
   * A 1-2 sentence summary of what the change does.
   * Should be concrete and specific, not vague.
   *
   * Good: "Adds rate limiting middleware to the /api/users endpoint"
   * Bad: "Makes improvements to the API"
   */
  summary: "string",

  /**
   * The WHY behind this change - what problem it solves or goal it achieves.
   * This is often the most valuable part for reviewers.
   *
   * Good: "Prevents API abuse and ensures fair usage across tenants"
   * Bad: "Improves the code"
   */
  purpose: "string",

  /**
   * The category of change.
   * Helps reviewers know what kind of review this needs.
   */
  scope: "'feature' | 'bugfix' | 'refactor' | 'config' | 'docs' | 'test' | 'mixed'",

  /**
   * High-level areas of the codebase that are touched.
   * Uses logical groupings, not just file paths.
   *
   * Examples: ["authentication", "database layer", "API routes"]
   */
  affectedAreas: "string[]",

  /**
   * Suggested order to review files for best understanding.
   * Entry points and core changes first, then ripple effects.
   *
   * This is optional because small diffs may not need ordering guidance.
   * Note: In ArkType, optional properties use "key?" syntax in the key name.
   */
  "suggestedReviewOrder?": "string[]",
});

/** TypeScript type extracted from the schema */
export type DerivedIntent = typeof DerivedIntentSchema.infer;
