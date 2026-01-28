/**
 * Intent Derivation Prompt - Analyze a diff to determine its intent
 *
 * This module builds prompts and runs LLM analysis to derive the intent
 * (purpose, scope, affected areas) from a diff.
 *
 * ## Architecture
 *
 * We use TanStack AI's structured output feature with ArkType schemas:
 * 1. Build a system prompt that establishes the "code reviewer" persona
 * 2. Build a user prompt containing the diff content
 * 3. Pass our ArkType schema as `outputSchema` to get validated JSON back
 *
 * This approach is more reliable than prompt-based JSON because:
 * - Uses Claude's native JSON mode (constrained generation)
 * - ArkType validates the response structure at runtime
 * - No manual JSON parsing or cleanup needed
 *
 * ## Prompt Engineering Concepts Applied
 *
 * 1. **Role/Persona Setting**: The system prompt establishes the LLM as an
 *    "experienced code reviewer" - this primes it to think like a reviewer
 *    rather than just describing changes mechanically.
 *
 * 2. **"WHY not WHAT" Guidance**: We explicitly tell the LLM to focus on
 *    purpose over description. Without this, LLMs tend to just describe
 *    the changes line-by-line.
 *
 * 3. **Tiered Context**: We only include high-priority files (Tier 1 & 2)
 *    to stay within token budgets while keeping the most important context.
 */

import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";

import type { ParsedDiff } from "../types/diff.js";
import type { ClassifiedFile } from "../types/loader.js";
import { DerivedIntentSchema, type DerivedIntent, type ChangeScope } from "../types/analysis.js";
import { wrapSchema } from "../utils/schema-compat.js";
import { formatDiffFile } from "../utils/format-diff.js";

// Re-export types for convenience
export type { DerivedIntent, ChangeScope };

/**
 * System prompt that establishes the LLM's role and behavior.
 *
 * ## Prompt Engineering Notes
 *
 * - **Persona**: "experienced code reviewer" sets the mindset
 * - **Task framing**: Explicitly state we want INTENT, not just changes
 * - **Quality guidance**: "WHY not WHAT" is a key principle
 *
 * Note: We don't need to specify JSON format here because TanStack AI's
 * outputSchema handles that automatically via Claude's native JSON mode.
 */
const SYSTEM_PROMPT = `You are an experienced code reviewer analyzing a diff to understand its intent.

Your goal is to determine:
1. WHAT the change does (summary)
2. WHY it's being made (purpose)
3. What category it falls into (scope)
4. What parts of the codebase are affected

## Key Principles

- **Explain WHY, not just WHAT**: Don't just describe the changes - explain their purpose
- **Be specific and concrete**: "Adds rate limiting to /api/users" is better than "improves API"
- **Consider the reviewer**: What would help someone understand this change quickly?
- **Suggest reading order**: Which files should a reviewer look at first?

## When Stated Intent is Provided

If the author has provided their stated intent, use it as additional context:
- It may clarify ambiguous changes
- It may reveal the "why" behind the change
- But derive intent from the CODE, not just the stated intent
- The stated intent could be incomplete or misleading

## Scope Definitions

- **feature**: New functionality or capability
- **bugfix**: Fixing incorrect behavior
- **refactor**: Code restructuring without behavior change
- **config**: Build, tooling, CI/CD, or environment changes
- **docs**: Documentation updates only
- **test**: Test additions or modifications only
- **mixed**: Combines multiple categories (common in real changes)

## Context Limitations

You are analyzing a diff, not the complete codebase. This means:
- Imports may reference files that exist but aren't shown in the diff
- Functions may be defined in files you can't see
- Types may be declared elsewhere
- New files created in this change may appear as imports but not as full file contents

Focus on understanding the intent from what IS visible in the diff. Don't flag concerns about code you can't see - assume referenced files and symbols exist unless there's clear evidence otherwise.`;

// Note: formatDiffFile and formatHunk are now imported from ../utils/format-diff.js
// They handle both regular diff formatting and deleted file summarization

/**
 * Build the user prompt containing the diff content.
 *
 * ## Prompt Engineering Notes
 *
 * - **Filtering**: We only include Tier 1 and Tier 2 files to save tokens
 *   and focus on the most important changes. Tier 3 (lock files, generated
 *   files) would add noise without value.
 *
 * - **Context setting**: We tell the LLM how many files and what we filtered
 *   so it knows it's seeing a curated view.
 *
 * - **Clear task statement**: End with an explicit request for analysis.
 *
 * - **Stated intent context**: When provided, we include the author's stated
 *   intent as additional context. This helps clarify ambiguous changes but
 *   the LLM should still derive intent from the actual code.
 *
 * - **Repository context**: When provided, shows files in directories touched
 *   by the diff, helping the LLM know what files exist beyond the diff.
 */
export function buildIntentPrompt(
  diff: ParsedDiff,
  classified: ClassifiedFile[],
  statedIntent?: string,
  repositoryContext?: string
): string {
  // Filter to only Tier 1 and Tier 2 files
  // Tier 3 (lock files, generated code, binaries) adds noise without value
  const relevantFiles = classified.filter((cf) => cf.tier <= 2);

  // Build the prompt sections
  const sections: string[] = [];

  // Overview section - helps LLM understand the scope
  sections.push(`## Diff Overview`);
  sections.push(`Total files changed: ${diff.files.length}`);
  sections.push(`Files included for analysis: ${relevantFiles.length}`);

  // Note what we filtered out (transparency for the LLM)
  const tier3Count = classified.filter((cf) => cf.tier === 3).length;
  if (tier3Count > 0) {
    sections.push(
      `(${tier3Count} files excluded: lock files, generated code, binaries)`
    );
  }

  sections.push(""); // blank line

  // Repository context section - files in touched directories
  if (repositoryContext) {
    sections.push(repositoryContext);
    sections.push(""); // blank line
  }

  // File list summary - quick overview before the details
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
      "Use this as context for understanding the change, but derive intent from the actual code changes."
    );
    sections.push("");
  }

  // Clear task instruction at the end
  // Putting the task at the end (after context) often works better
  // because it's fresh in the model's "attention"
  sections.push("---");
  sections.push(`Analyze this diff and provide the intent analysis. Focus on WHY, not just WHAT.

REQUIRED OUTPUT FIELDS (all are mandatory):
- summary: string - 1-2 sentence summary of what the change does
- purpose: string - the WHY behind this change
- scope: "feature" | "bugfix" | "refactor" | "config" | "docs" | "test" | "mixed"
- affectedAreas: string[] - high-level areas of the codebase touched

OPTIONAL FIELDS:
- suggestedReviewOrder: string[] - suggested order to review files`);

  return sections.join("\n");
}

/**
 * Derive the intent of a diff using LLM analysis.
 *
 * This is the main entry point for intent derivation. It:
 * 1. Builds the prompt from the diff and classification
 * 2. Calls TanStack AI's chat() with our ArkType schema
 * 3. Returns the validated, typed result
 *
 * ## How Structured Output Works
 *
 * TanStack AI's `outputSchema` option:
 * 1. Converts our ArkType schema to JSON Schema
 * 2. Passes it to Claude's native JSON mode (constrained generation)
 * 3. Validates the response against the schema
 * 4. Returns typed data matching our DerivedIntent type
 *
 * This is more reliable than asking for JSON in the prompt because
 * Claude's JSON mode guarantees valid JSON structure.
 *
 * @param diff - The parsed diff to analyze
 * @param classified - Files classified by tier (from classifyDiff)
 * @returns The derived intent with summary, purpose, scope, etc.
 *
 * @example
 * ```ts
 * const diff = parseDiff(diffText);
 * const classified = classifyDiff(diff);
 * const intent = await deriveIntent(diff, classified);
 *
 * console.log(intent.summary);  // "Adds rate limiting to API endpoints"
 * console.log(intent.purpose);  // "Prevents abuse and ensures fair usage"
 * console.log(intent.scope);    // "feature"
 * ```
 */
export async function deriveIntent(
  diff: ParsedDiff,
  classified: ClassifiedFile[],
  statedIntent?: string,
  repositoryContext?: string
): Promise<DerivedIntent> {
  // Build the prompt with diff content (and stated intent/context if provided)
  const userPrompt = buildIntentPrompt(diff, classified, statedIntent, repositoryContext);

  try {
    // Use TanStack AI's chat() with structured output
    // The outputSchema tells it to:
    // 1. Use Claude's native JSON mode
    // 2. Validate response against our ArkType schema
    // 3. Return typed data
    const result = await chat({
      adapter: anthropicText("claude-sonnet-4-5"),
      systemPrompts: [SYSTEM_PROMPT],
      messages: [{ role: "user", content: userPrompt }],
      // Wrap schema for TanStack AI compatibility (ArkType schemas are functions,
      // but TanStack AI expects typeof === 'object' for Standard Schema detection)
      outputSchema: wrapSchema(DerivedIntentSchema),
      // Lower temperature for more consistent, focused analysis
      temperature: 0.3,
      // Don't stream - we want the final structured result
      stream: false,
      // Ensure enough tokens for detailed intent analysis -
      // default 1024 tokens can truncate responses causing validation failures
      maxTokens: 4096,
    });

    // Result is already validated and typed as DerivedIntent
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
