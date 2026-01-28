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

/**
 * Risk severity levels for potential issues in a diff.
 *
 * ## Calibration Philosophy
 *
 * Risk severity should be calibrated to avoid "crying wolf":
 * - **low**: Worth noting but unlikely to cause problems
 * - **medium**: Should be reviewed carefully, may need changes
 * - **high**: Likely to cause issues if not addressed
 * - **critical**: Must be addressed before merge (security, data loss, etc.)
 *
 * Most risks should be low/medium. High/critical should be rare and specific.
 */
export const RiskSeveritySchema = type("'low' | 'medium' | 'high' | 'critical'");
export type RiskSeverity = typeof RiskSeveritySchema.infer;

/**
 * Confidence level for the assessment.
 *
 * Acknowledges that LLM analysis has uncertainty:
 * - **high**: Clear evidence in the diff, straightforward analysis
 * - **medium**: Some inference required, context may be missing
 * - **low**: Speculative, based on patterns that may not apply
 */
export const ConfidenceLevelSchema = type("'high' | 'medium' | 'low'");
export type ConfidenceLevel = typeof ConfidenceLevelSchema.infer;

/**
 * Schema for a single identified risk.
 *
 * Key design principle: Every risk must cite SPECIFIC EVIDENCE from the diff.
 * Vague warnings like "this could be slow" without pointing to actual code
 * are not useful and contribute to alert fatigue.
 */
export const RiskSchema = type({
  /**
   * How severe is this risk?
   * See RiskSeveritySchema for calibration guidance.
   */
  severity: "'low' | 'medium' | 'high' | 'critical'",

  /**
   * Category of risk for grouping and filtering.
   * Examples: "security", "breaking-change", "performance", "error-handling",
   * "backwards-compatibility", "test-coverage", "data-integrity"
   */
  category: "string",

  /**
   * What the risk is - clear, specific description.
   * Good: "Removed null check could cause NPE when user.email is undefined"
   * Bad: "Error handling could be improved"
   */
  description: "string",

  /**
   * What in the diff suggests this risk - MUST cite specific code/changes.
   * Good: "Line 45 removes `if (user?.email)` guard before `.toLowerCase()`"
   * Bad: "The code changes how errors are handled"
   */
  evidence: "string",

  /**
   * Which file(s) this risk relates to. Optional because some risks
   * may span multiple files or be about the overall change.
   */
  "file?": "string",

  /**
   * How to address this risk. Optional because not all risks have
   * clear mitigations, and sometimes just flagging is enough.
   */
  "mitigation?": "string",
});
export type Risk = typeof RiskSchema.infer;

/**
 * Schema for the complete risk assessment of a diff.
 *
 * ## Design Philosophy
 *
 * 1. **Overall risk is the MAX severity**, not average - one critical risk
 *    makes the whole change high-risk regardless of other low risks.
 *
 * 2. **Summary should be actionable** - "2 high-severity security risks require
 *    attention before merge" is more useful than "Some issues found".
 *
 * 3. **Confidence acknowledges uncertainty** - better to say "medium confidence,
 *    missing test context" than to claim certainty when context is limited.
 */
export const RiskAssessmentSchema = type({
  /**
   * Highest severity among all identified risks.
   * If no risks, this should be "low".
   */
  overallRisk: "'low' | 'medium' | 'high' | 'critical'",

  /**
   * 1-2 sentence actionable summary.
   * Good: "2 high-severity risks: auth bypass in login.ts:45 and unvalidated input in api.ts:23"
   * Bad: "Some potential issues were found in this change"
   */
  summary: "string",

  /**
   * Array of identified risks, ordered by severity (critical first).
   */
  risks: RiskSchema.array(),

  /**
   * How confident is this assessment?
   * Should be lower when: limited context, generated code, unfamiliar patterns.
   */
  confidence: "'high' | 'medium' | 'low'",
});
export type RiskAssessment = typeof RiskAssessmentSchema.infer;
