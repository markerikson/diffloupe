/**
 * Intent Alignment Prompt - Compare stated vs derived intent
 *
 * This is DiffLoupe's core differentiator: comparing what someone *says* they're
 * doing vs what the code *actually* does.
 *
 * ## Architecture
 *
 * Unlike intent/risks which analyze diffs directly, alignment analysis:
 * 1. Takes the already-derived intent as input
 * 2. Compares it against the stated intent
 * 3. Uses the diff for evidence when citing specific mismatches
 *
 * This runs AFTER intent derivation completes.
 */

import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";

import type { ParsedDiff, DiffFile, DiffHunk } from "../types/diff.js";
import type { ClassifiedFile } from "../types/loader.js";
import type { DerivedIntent } from "../types/analysis.js";
import { IntentAlignmentSchema, type IntentAlignment } from "../types/analysis.js";
import { wrapSchema } from "../utils/schema-compat.js";

// Re-export types for convenience
export type { IntentAlignment };

/**
 * System prompt for intent alignment analysis.
 *
 * ## Prompt Engineering Notes
 *
 * - **Persona**: A reviewer comparing claims vs reality
 * - **Focus on evidence**: Every mismatch/missing/unstated must cite the diff
 * - **Calibration**: "aligned" should be the default unless there's real divergence
 */
const SYSTEM_PROMPT = `You are comparing what an author claims their code change does (stated intent) against what it actually does (derived intent).

Your goal is to identify:
1. Do the stated and derived intents align?
2. What matches between claimed and actual behavior?
3. What mismatches - where the code does something different than stated?
4. What's missing - stated but not implemented?
5. What's unstated - implemented but not mentioned (scope creep)?

## Alignment Levels

- **aligned**: The code does what the author says, with no significant extra or missing pieces.
  Use this when the stated intent accurately describes the changes.

- **partial**: Some aspects match, but there are notable gaps or additions.
  Use when: core intent is correct but scope differs, or some stated items are missing.

- **misaligned**: The code does something substantially different than claimed.
  Use when: stated intent is misleading, or changes don't match the stated goal.

## Calibration Guidelines

- Be generous with "aligned" - minor wording differences don't matter
- "partial" is common - real changes often include cleanup/related fixes not mentioned
- "misaligned" should be rare - only when there's genuine mismatch of stated vs actual
- Vague stated intent ("misc fixes", "updates") should get medium/low confidence
- If stated intent is just a feature name with no details, focus on whether the feature exists

## Evidence Requirements

For each item in matches/mismatches/missing/unstated, cite specific evidence:
- Good: "Added null check in UserService.ts:45 as stated"
- Good: "Error refactoring not mentioned but present in 3 files"
- Bad: "Some things match"
- Bad: "There might be missing features"

## Context Limitations

You are comparing stated intent against a diff, not the complete codebase. This means:
- New files created in this change may not appear in the diff hunks
- Imports may reference files that exist but aren't shown
- If an import references a file that isn't visible, assume it likely exists

Don't flag "missing implementation" if the code imports from a file you can't see - it's probably implemented there. Focus on alignment issues evident from what IS visible.

## Output Quality

- Keep summary to 1-2 sentences - the key finding
- Order matches/mismatches/missing/unstated by importance
- Empty arrays are fine - not every analysis will have all categories
- Set confidence based on how clear the comparison is`;

/**
 * Format diff file for context (reused pattern from intent/risks)
 */
function formatDiffFile(file: DiffFile): string {
  const lines: string[] = [];

  const statusLabel = file.status.toUpperCase();
  if (file.status === "renamed" && file.oldPath) {
    lines.push(`=== ${file.oldPath} → ${file.path} (${statusLabel}) ===`);
  } else {
    lines.push(`=== ${file.path} (${statusLabel}) ===`);
  }

  if (file.isBinary) {
    lines.push("[binary file]");
    return lines.join("\n");
  }

  for (const hunk of file.hunks) {
    lines.push(formatHunk(hunk));
  }

  return lines.join("\n");
}

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
 * Build the user prompt for alignment analysis.
 *
 * @param statedIntent - What the author says they're doing
 * @param derivedIntent - What the LLM determined from the diff
 * @param diff - The actual diff for evidence
 * @param classified - Classified files for filtering
 * @param repositoryContext - Optional context showing files in touched directories
 */
export function buildAlignmentPrompt(
  statedIntent: string,
  derivedIntent: DerivedIntent,
  _diff: ParsedDiff,
  classified: ClassifiedFile[],
  repositoryContext?: string
): string {
  const sections: string[] = [];

  // Section 1: Stated Intent
  sections.push("## Author's Stated Intent");
  sections.push("");
  sections.push(statedIntent);
  sections.push("");

  // Section 2: Derived Intent (what analysis found)
  sections.push("## Derived Intent (from diff analysis)");
  sections.push("");
  sections.push(`**Summary:** ${derivedIntent.summary}`);
  sections.push(`**Purpose:** ${derivedIntent.purpose}`);
  sections.push(`**Scope:** ${derivedIntent.scope}`);
  sections.push(`**Affected Areas:** ${derivedIntent.affectedAreas.join(", ")}`);
  sections.push("");

  // Repository context section - files in touched directories
  if (repositoryContext) {
    sections.push(repositoryContext);
    sections.push("");
  }

  // Section 3: Diff content for evidence
  sections.push("## Diff Content (for evidence)");
  sections.push("");

  const relevantFiles = classified.filter((cf) => cf.tier <= 2);
  for (const cf of relevantFiles) {
    sections.push(formatDiffFile(cf.file));
    sections.push("");
  }

  // Task instruction
  sections.push("---");
  sections.push("");
  sections.push(`Compare the stated intent against the derived intent and the actual diff.

For each finding, cite specific evidence from the diff.

If the stated intent is vague, note that in the summary and set confidence accordingly.`);

  return sections.join("\n");
}

/**
 * Perform intent alignment analysis.
 *
 * This compares what the author claims vs what the code actually does.
 * Only called when stated intent is provided.
 *
 * @param statedIntent - What the author says they're doing
 * @param derivedIntent - What was derived from diff analysis
 * @param diff - The parsed diff
 * @param classified - Classified files
 * @returns Intent alignment assessment
 *
 * @example
 * ```ts
 * if (statedIntent) {
 *   const alignment = await alignIntent(statedIntent, derivedIntent, diff, classified);
 *   console.log(alignment.alignment); // "aligned" | "partial" | "misaligned"
 *   console.log(alignment.summary);
 * }
 * ```
 */
export async function alignIntent(
  statedIntent: string,
  derivedIntent: DerivedIntent,
  diff: ParsedDiff,
  classified: ClassifiedFile[],
  repositoryContext?: string
): Promise<IntentAlignment> {
  const userPrompt = buildAlignmentPrompt(statedIntent, derivedIntent, diff, classified, repositoryContext);

  const result = await chat({
    adapter: anthropicText("claude-sonnet-4-5"),
    systemPrompts: [SYSTEM_PROMPT],
    messages: [{ role: "user", content: userPrompt }],
    outputSchema: wrapSchema(IntentAlignmentSchema),
    // Lower temperature for consistent analysis
    temperature: 0.3,
    stream: false,
    // Ensure enough tokens for alignment analysis -
    // default 1024 tokens can truncate responses causing validation failures
    maxTokens: 4096,
  });

  return result;
}
