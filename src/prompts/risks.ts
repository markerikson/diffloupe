/**
 * Risk Assessment Prompt - Analyze a diff to identify potential risks
 *
 * This module complements intent derivation: while intent asks "what is this
 * trying to do?", risk assessment asks "what could go wrong?"
 *
 * ## Architecture
 *
 * Similar to intent.ts, we use TanStack AI's structured output with ArkType:
 * 1. System prompt establishes a "security-minded code reviewer" persona
 * 2. User prompt contains the diff with context about what was filtered
 * 3. ArkType schema ensures validated, typed output
 *
 * ## Prompt Engineering Concepts Applied
 *
 * 1. **Role/Persona Setting**: "Security-minded senior code reviewer" primes
 *    the LLM to think about edge cases, security implications, and failure modes.
 *
 * 2. **Evidence Requirement**: We explicitly require citing specific code from
 *    the diff. This grounds the analysis in reality and prevents vague warnings.
 *
 * 3. **Calibration Guidance**: We give explicit examples of severity levels to
 *    prevent "crying wolf" - if everything is critical, nothing is.
 *
 * 4. **Category Taxonomy**: Providing categories helps organize findings and
 *    lets reviewers filter by what they care about (e.g., just security).
 *
 * 5. **Confidence Acknowledgment**: Explicitly asking the model to assess its
 *    confidence encourages it to flag when context is limited.
 */

import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";

import type { ParsedDiff, DiffFile, DiffHunk } from "../types/diff.js";
import type { ClassifiedFile } from "../types/loader.js";
import {
  RiskAssessmentSchema,
  type RiskAssessment,
  type Risk,
  type RiskSeverity,
} from "../types/analysis.js";
import { wrapSchema } from "../utils/schema-compat.js";

// Re-export types for convenience
export type { RiskAssessment, Risk, RiskSeverity };

/**
 * System prompt that establishes the LLM's role as a security-minded reviewer.
 *
 * ## Prompt Engineering Notes
 *
 * - **Persona**: "Security-minded senior code reviewer" - not a paranoid auditor,
 *   but an experienced dev who knows what to watch for.
 *
 * - **Evidence Requirement**: The most important instruction. Without this,
 *   LLMs tend to generate generic warnings. By requiring specific line citations,
 *   we force grounded analysis.
 *
 * - **Calibration Examples**: Concrete examples of each severity level help
 *   the model understand the scale. This is crucial for avoiding alert fatigue.
 *
 * - **"Don't Cry Wolf" Instruction**: Explicitly telling the model it's okay
 *   to find nothing reduces the tendency to manufacture risks.
 */
const SYSTEM_PROMPT = `You are a security-minded senior code reviewer analyzing a diff for potential risks.

Your goal is to identify concrete risks in this change - things that could go wrong in production, security vulnerabilities, breaking changes, or issues that could cause problems for users or the codebase.

## Key Principles

- **Cite specific evidence**: Every risk MUST reference specific code from the diff. "Line 45 removes the null check before calling .toLowerCase()" is good. "Error handling could be better" is useless.

- **Don't cry wolf**: Not every change is risky. If the code looks fine, say so. Flagging non-issues creates alert fatigue and makes real issues harder to spot.

- **Be calibrated on severity**:
  - **critical**: Must fix before merge. Security vulnerabilities, data loss, auth bypass.
    Example: "Removed password hashing - passwords will be stored in plaintext"
  - **high**: Likely to cause production issues if not addressed.
    Example: "Missing null check will throw NPE when optional field is absent"
  - **medium**: Should be reviewed carefully, may need changes.
    Example: "API response format changed - clients may need updates"
  - **low**: Worth noting but unlikely to cause problems.
    Example: "New dependency added - should verify it's actively maintained"

- **Consider the full picture**: Think about:
  - Breaking changes (API signatures, removed exports, changed behavior)
  - Security (auth, input validation, secrets, injection)
  - Error handling (uncaught exceptions, missing error paths)
  - Performance (N+1 queries, unbounded loops, missing pagination)
  - Backwards compatibility (migrations, protocol changes)
  - Test coverage (removed tests, untested paths)

## Risk Categories

Use these categories for consistency:
- security: Auth, secrets, injection, validation
- breaking-change: API changes, removed exports, changed contracts
- performance: N+1, unbounded operations, missing indexes
- error-handling: Missing catches, unhandled cases, error propagation
- backwards-compatibility: Migrations, protocol changes, data format changes
- test-coverage: Removed tests, untested risky paths
- data-integrity: Race conditions, partial updates, validation gaps
- maintainability: Complexity, coupling, undocumented behavior (use sparingly)

## When Stated Intent is Provided

If the author has stated their intent, consider whether risks relate to:
- Gaps between stated intent and actual implementation
- Security/safety issues in how the stated goal is achieved
- Missing validation or error handling for the stated use case

## Context Limitations

You are analyzing a diff, not the complete codebase. This means:
- Imports may reference files that exist but aren't shown in the diff
- Functions may be defined in files you can't see
- Types may be declared elsewhere
- New files created in this change may appear as imports but not as full file contents

When you see something that MIGHT be an issue but could be fine with full context:
- Don't flag it as critical/high severity
- Either skip it entirely, or note it as low severity with "may be resolved by unseen context"
- Focus on issues that are clearly evident FROM the diff itself

## Output Quality

- Order risks by severity (critical first)
- Keep descriptions concise but specific
- If a risk has a clear mitigation, include it
- If you're uncertain, reflect that in confidence level`;

/**
 * Format a single diff file for inclusion in the prompt.
 *
 * Reuses the same format as intent.ts for consistency - LLMs work better
 * when they see consistent formatting across similar tasks.
 */
function formatDiffFile(file: DiffFile): string {
  const lines: string[] = [];

  // Header with path and status
  const statusLabel = file.status.toUpperCase();
  if (file.status === "renamed" && file.oldPath) {
    lines.push(`=== ${file.oldPath} → ${file.path} (${statusLabel}) ===`);
  } else {
    lines.push(`=== ${file.path} (${statusLabel}) ===`);
  }

  // Binary files have no hunks
  if (file.isBinary) {
    lines.push("[binary file]");
    return lines.join("\n");
  }

  // Include each hunk
  for (const hunk of file.hunks) {
    lines.push(formatHunk(hunk));
  }

  return lines.join("\n");
}

/**
 * Format a diff hunk with its lines.
 *
 * Standard diff format (+/-/space) is familiar to both LLMs and humans.
 */
function formatHunk(hunk: DiffHunk): string {
  const lines: string[] = [hunk.header];

  for (const line of hunk.lines) {
    const prefix =
      line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
    lines.push(`${prefix}${line.content}`);
  }

  return lines.join("\n");
}

/**
 * Build the user prompt containing the diff content for risk analysis.
 *
 * ## Prompt Engineering Notes
 *
 * - **Filtering Transparency**: We tell the model what was filtered out so it
 *   knows it might be missing context (e.g., test files in Tier 3).
 *
 * - **Task at End**: Putting the specific task instruction at the end (after
 *   all the context) keeps it fresh in the model's attention window.
 *
 * - **Explicit "Nothing Found" Instruction**: Tells the model it's okay to
 *   report no risks, reducing the pressure to manufacture issues.
 *
 * - **Stated intent context**: When provided, the model considers risks in
 *   relation to the stated goal (e.g., security issues in achieving that goal).
 */
export function buildRiskPrompt(
  diff: ParsedDiff,
  classified: ClassifiedFile[],
  statedIntent?: string
): string {
  // Filter to only Tier 1 and Tier 2 files
  const relevantFiles = classified.filter((cf) => cf.tier <= 2);

  const sections: string[] = [];

  // Overview section
  sections.push(`## Diff Overview`);
  sections.push(`Total files changed: ${diff.files.length}`);
  sections.push(`Files included for analysis: ${relevantFiles.length}`);

  // Explain what was filtered - important for confidence calibration
  const tier3Files = classified.filter((cf) => cf.tier === 3);
  if (tier3Files.length > 0) {
    sections.push(
      `(${tier3Files.length} files excluded from analysis: lock files, generated code, binaries)`
    );
    // Note if tests were excluded - relevant for test coverage risk
    const excludedTests = tier3Files.filter(
      (cf) =>
        cf.file.path.includes(".test.") || cf.file.path.includes(".spec.")
    );
    if (excludedTests.length > 0) {
      sections.push(
        `Note: ${excludedTests.length} test file(s) were in excluded category`
      );
    }
  }

  sections.push(""); // blank line

  // File list summary
  sections.push("## Files Changed");
  for (const cf of relevantFiles) {
    const status = cf.file.status;
    sections.push(`- ${cf.file.path} (${status})`);
  }

  sections.push(""); // blank line

  // Detailed diff content
  sections.push("## Diff Content");
  sections.push("");

  for (const cf of relevantFiles) {
    sections.push(formatDiffFile(cf.file));
    sections.push(""); // blank line between files
  }

  // Stated intent section (if provided)
  if (statedIntent) {
    sections.push("## Author's Stated Intent");
    sections.push("");
    sections.push(statedIntent);
    sections.push("");
    sections.push(
      "Consider whether any risks relate to gaps between this stated intent and the actual implementation."
    );
    sections.push("");
  }

  // Task instruction at the end
  sections.push("---");
  sections.push(`Analyze this diff for potential risks.

Requirements:
1. For each risk, cite SPECIFIC evidence from the diff (file, line, code snippet)
2. Only flag issues that have concrete evidence - no generic warnings
3. If the change looks safe, it's okay to return an empty risks array
4. Order risks by severity (critical/high first)
5. Set confidence based on how much context you have

REQUIRED OUTPUT FIELDS (all are mandatory):
- overallRisk: "low" | "medium" | "high" | "critical" - the highest severity among all risks (use "low" if no risks)
- summary: string - 1-2 sentence actionable summary
- risks: array of risk objects (can be empty array [] if no risks found)
- confidence: "high" | "medium" | "low" - how confident you are in this assessment

Each risk object MUST have:
- severity: "low" | "medium" | "high" | "critical"
- category: string (e.g., "security", "breaking-change", "performance")
- description: string - what the risk is
- evidence: string - specific code/line from the diff`);

  return sections.join("\n");
}

/**
 * Assess risks in a diff using LLM analysis.
 *
 * This is the main entry point for risk assessment. It:
 * 1. Builds the prompt from the diff and classification
 * 2. Calls TanStack AI's chat() with our ArkType schema
 * 3. Returns the validated, typed result
 *
 * ## How This Complements Intent Derivation
 *
 * Intent answers: "What is this change trying to accomplish?"
 * Risk assessment answers: "What could go wrong with this change?"
 *
 * Together they provide a complete picture for reviewers:
 * - Intent helps understand the purpose (context for the review)
 * - Risks highlight what to pay attention to (focus for the review)
 *
 * @param diff - The parsed diff to analyze
 * @param classified - Files classified by tier (from classifyDiff)
 * @returns Risk assessment with overall severity, summary, and individual risks
 *
 * @example
 * ```ts
 * const diff = parseDiff(diffText);
 * const classified = classifyDiff(diff);
 * const risks = await assessRisks(diff, classified);
 *
 * if (risks.overallRisk === 'critical') {
 *   console.log('BLOCKING:', risks.summary);
 * }
 * for (const risk of risks.risks) {
 *   console.log(`[${risk.severity}] ${risk.category}: ${risk.description}`);
 * }
 * ```
 */
export async function assessRisks(
  diff: ParsedDiff,
  classified: ClassifiedFile[],
  statedIntent?: string
): Promise<RiskAssessment> {
  // Build the prompt with diff content (and stated intent if provided)
  const userPrompt = buildRiskPrompt(diff, classified, statedIntent);

  try {
    // Use TanStack AI's chat() with structured output
    const result = await chat({
      adapter: anthropicText("claude-sonnet-4-5"),
      systemPrompts: [SYSTEM_PROMPT],
      messages: [{ role: "user", content: userPrompt }],
      // Wrap schema for TanStack AI compatibility (ArkType schemas are functions,
      // but TanStack AI expects typeof === 'object' for Standard Schema detection)
      outputSchema: wrapSchema(RiskAssessmentSchema),
      // Lower temperature for consistent, focused analysis
      // Slightly higher than intent (0.3) because we want it to consider
      // edge cases, but still deterministic
      temperature: 0.4,
      stream: false,
      // Risk analysis can produce detailed output with multiple risks -
      // default 1024 tokens can truncate responses causing validation failures
      maxTokens: 8192,
    });

    return result;
  } catch (error) {
    // Enhance validation errors with debugging info
    if (error instanceof Error && error.message.includes("Validation failed")) {
      const enhancedError = new Error(
        `${error.message}\n\nThis usually means the LLM response was missing required fields. ` +
        `Check that the diff wasn't too large (${diff.files.length} files, ` +
        `${classified.filter(c => c.tier <= 2).length} analyzed).`
      );
      enhancedError.cause = error;
      throw enhancedError;
    }
    throw error;
  }
}
