/**
 * Two-Pass Analysis Strategy for Medium-Sized Diffs
 *
 * This module implements the two-pass strategy for diffs in the 16-40 file range:
 *
 * ## Strategy
 *
 * **Pass 1 - Quick Overview:**
 * - Send compressed context (file list + change stats, first ~20 lines of each file)
 * - LLM identifies which files need detailed review and why
 * - Returns flagged files and initial risk indicators
 *
 * **Pass 2 - Deep Dive:**
 * - Only include full diff content for flagged files
 * - Run full intent + risk analysis on this subset
 * - Produces detailed findings for areas of concern
 *
 * **Combine:**
 * - Merge overview findings with deep-dive results
 * - Produce unified intent and risk assessment
 *
 * ## Benefits
 * - Efficient token usage: only deep-dive where needed
 * - Catches overall intent first, then focuses on risks
 * - Better quality than trying to analyze everything at once
 */

import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { type } from "arktype";

import type { ParsedDiff, DiffFile } from "../../types/diff.js";
import type { ClassifiedFile } from "../../types/loader.js";
import type {
  DerivedIntent,
  RiskAssessment,
  Risk,
} from "../../types/analysis.js";
import { RiskAssessmentSchema } from "../../types/analysis.js";
import { wrapSchema } from "../../utils/schema-compat.js";
import { formatDiffFile } from "../../utils/format-diff.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Result from the overview pass.
 */
export interface OverviewResult {
  /** High-level summary of what the diff does */
  summary: string;
  /** Files identified as needing detailed review */
  flaggedFiles: string[];
  /** Quick-scan risks identified in the overview */
  initialRisks: Risk[];
  /** Derived intent from the overview (may be refined in deep-dive) */
  overviewIntent: Partial<DerivedIntent>;
}

/**
 * Combined result from both passes.
 */
export interface TwoPassAnalysisResult {
  intent: DerivedIntent;
  risks: RiskAssessment;
  /** Metadata about the two-pass analysis */
  metadata: {
    strategy: "two-pass";
    overviewFileCount: number;
    flaggedFileCount: number;
    deepDiveFileCount: number;
  };
}

// ============================================================================
// Overview Pass Schema
// ============================================================================

/**
 * Schema for the overview pass response.
 * This is a lighter-weight analysis focused on identifying areas of concern.
 */
const OverviewResponseSchema = type({
  /** High-level summary of what this diff accomplishes */
  summary: "string",
  /** The likely purpose/goal of this change */
  purpose: "string",
  /** Category of change */
  scope: "'feature' | 'bugfix' | 'refactor' | 'config' | 'docs' | 'test' | 'mixed'",
  /** High-level areas affected */
  affectedAreas: "string[]",
  /** Files that need detailed review, with reasons */
  flaggedFiles: type({
    path: "string",
    reason: "string",
  }).array(),
  /** Any immediately obvious risks spotted in the overview */
  initialRisks: type({
    severity: "'low' | 'medium' | 'high' | 'critical'",
    category: "string",
    description: "string",
    evidence: "string",
    "file?": "string",
  }).array(),
});

// ============================================================================
// Constants
// ============================================================================

/** Number of lines to show from each file in overview */
const OVERVIEW_LINES_PER_FILE = 20;

// ============================================================================
// Overview Pass Implementation
// ============================================================================

const OVERVIEW_SYSTEM_PROMPT = `You are an experienced code reviewer doing a quick scan of a diff to identify areas needing detailed review.

Your goal in this OVERVIEW pass is to:
1. Understand the overall intent of the change
2. Identify which files need careful, detailed review
3. Flag any immediately obvious risks

## Key Principles

- This is a QUICK SCAN, not a detailed review
- Flag files that have:
  - Security-sensitive changes (auth, validation, secrets)
  - Complex logic changes
  - API/interface changes that could break things
  - Error handling modifications
  - Database/data layer changes
- Don't flag routine files:
  - Pure test files (unless testing critical paths)
  - Config files with minor changes
  - Formatting/style changes
  - Simple type additions

## Scope Definitions

- **feature**: New functionality
- **bugfix**: Fixing incorrect behavior
- **refactor**: Code restructuring without behavior change
- **config**: Build, tooling, CI/CD changes
- **docs**: Documentation only
- **test**: Test additions/modifications only
- **mixed**: Multiple categories

## Output Quality

- Be selective: flag 20-50% of files, not everything
- Order flagged files by importance
- Keep reasons concise but specific`;

/**
 * Format a file for the overview pass.
 * Shows file path, stats, and first N lines of changes.
 */
function formatFileForOverview(file: DiffFile): string {
  const lines: string[] = [];

  // Header with stats
  const addedLines = file.hunks.reduce(
    (sum, h) => sum + h.lines.filter((l) => l.type === "add").length,
    0
  );
  const deletedLines = file.hunks.reduce(
    (sum, h) => sum + h.lines.filter((l) => l.type === "delete").length,
    0
  );

  const statusLabel = file.status.toUpperCase();
  if (file.status === "renamed" && file.oldPath) {
    lines.push(
      `=== ${file.oldPath} → ${file.path} (${statusLabel}) [+${addedLines}/-${deletedLines}] ===`
    );
  } else {
    lines.push(
      `=== ${file.path} (${statusLabel}) [+${addedLines}/-${deletedLines}] ===`
    );
  }

  // Binary files - just note it
  if (file.isBinary) {
    lines.push("[binary file]");
    return lines.join("\n");
  }

  // Collect first N lines of actual changes (not context)
  let changeLineCount = 0;
  for (const hunk of file.hunks) {
    if (changeLineCount >= OVERVIEW_LINES_PER_FILE) break;

    lines.push(hunk.header);
    for (const line of hunk.lines) {
      if (changeLineCount >= OVERVIEW_LINES_PER_FILE) {
        lines.push(`... (${addedLines + deletedLines - changeLineCount} more changed lines)`);
        break;
      }
      if (line.type === "add" || line.type === "delete") {
        const prefix = line.type === "add" ? "+" : "-";
        lines.push(`${prefix}${line.content}`);
        changeLineCount++;
      }
    }
  }

  return lines.join("\n");
}

/**
 * Build the prompt for the overview pass.
 */
export function buildOverviewPrompt(
  diff: ParsedDiff,
  classified: ClassifiedFile[],
  statedIntent?: string,
  repositoryContext?: string
): string {
  const relevantFiles = classified.filter((cf) => cf.tier <= 2);
  const sections: string[] = [];

  // Overview section
  sections.push("## Diff Overview");
  sections.push(`Total files changed: ${diff.files.length}`);
  sections.push(`Files for overview: ${relevantFiles.length}`);

  const tier3Count = classified.filter((cf) => cf.tier === 3).length;
  if (tier3Count > 0) {
    sections.push(
      `(${tier3Count} files excluded: lock files, generated code, binaries)`
    );
  }
  sections.push("");

  // Repository context if available
  if (repositoryContext) {
    sections.push(repositoryContext);
    sections.push("");
  }

  // File list with stats
  sections.push("## Files Changed (with stats)");
  for (const cf of relevantFiles) {
    const file = cf.file;
    const addedLines = file.hunks.reduce(
      (sum, h) => sum + h.lines.filter((l) => l.type === "add").length,
      0
    );
    const deletedLines = file.hunks.reduce(
      (sum, h) => sum + h.lines.filter((l) => l.type === "delete").length,
      0
    );
    sections.push(`- ${file.path} (${file.status}) [+${addedLines}/-${deletedLines}]`);
  }
  sections.push("");

  // Compressed diff content (first N lines per file)
  sections.push("## Diff Preview (first ~20 changed lines per file)");
  sections.push("");
  for (const cf of relevantFiles) {
    sections.push(formatFileForOverview(cf.file));
    sections.push("");
  }

  // Stated intent if provided
  if (statedIntent) {
    sections.push("## Author's Stated Intent");
    sections.push("");
    sections.push(statedIntent);
    sections.push("");
  }

  // Task instruction
  sections.push("---");
  sections.push(`Analyze this diff OVERVIEW and identify which files need detailed review.

REQUIRED OUTPUT:
- summary: string - 1-2 sentence summary of what this diff does
- purpose: string - why this change is being made
- scope: "feature" | "bugfix" | "refactor" | "config" | "docs" | "test" | "mixed"
- affectedAreas: string[] - high-level areas touched
- flaggedFiles: array of { path: string, reason: string } - files needing detailed review
- initialRisks: array of any immediately obvious risks (can be empty)

Be SELECTIVE with flaggedFiles - flag 20-50% of files, not everything.`);

  return sections.join("\n");
}

/**
 * Run the overview pass to identify areas of concern.
 */
export async function runOverviewPass(
  diff: ParsedDiff,
  classified: ClassifiedFile[],
  statedIntent?: string,
  repositoryContext?: string
): Promise<OverviewResult> {
  const userPrompt = buildOverviewPrompt(
    diff,
    classified,
    statedIntent,
    repositoryContext
  );

  const response = await chat({
    adapter: anthropicText("claude-sonnet-4-5"),
    systemPrompts: [OVERVIEW_SYSTEM_PROMPT],
    messages: [{ role: "user", content: userPrompt }],
    outputSchema: wrapSchema(OverviewResponseSchema),
    temperature: 0.3,
    stream: false,
    maxTokens: 4096,
  });

  return {
    summary: response.summary,
    flaggedFiles: response.flaggedFiles.map((f: { path: string; reason: string }) => f.path),
    initialRisks: response.initialRisks.map((r: { severity: "low" | "medium" | "high" | "critical"; category: string; description: string; evidence: string; file?: string }) => ({
      severity: r.severity,
      category: r.category,
      description: r.description,
      evidence: r.evidence,
      file: r.file,
    })),
    overviewIntent: {
      summary: response.summary,
      purpose: response.purpose,
      scope: response.scope,
      affectedAreas: response.affectedAreas,
    },
  };
}

// ============================================================================
// Deep-Dive Pass Implementation
// ============================================================================

const DEEPDIVE_SYSTEM_PROMPT = `You are an experienced code reviewer doing a DETAILED analysis of specific files that were flagged for careful review.

This is a DEEP-DIVE pass. You've already done a quick overview and now need to:
1. Thoroughly analyze the flagged files
2. Identify all risks in these files
3. Provide detailed, specific findings

## Key Principles

- Every risk MUST cite specific evidence from the diff
- Don't repeat findings already noted in the overview - focus on NEW details
- Be thorough - these files were flagged for a reason

## Risk Categories

- security: Auth, secrets, injection, validation
- breaking-change: API changes, removed exports
- performance: N+1, unbounded operations
- error-handling: Missing catches, unhandled cases
- backwards-compatibility: Migrations, protocol changes
- data-integrity: Race conditions, partial updates
- test-coverage: Removed tests, untested risky paths

## Severity Calibration

- **critical**: Must fix before merge (security vulns, data loss)
- **high**: Likely production issues if not addressed
- **medium**: Should review carefully
- **low**: Worth noting but unlikely to cause problems`;

/**
 * Build the prompt for the deep-dive pass.
 * Only includes full content for flagged files.
 */
export function buildDeepDivePrompt(
  _diff: ParsedDiff,
  classified: ClassifiedFile[],
  flaggedFiles: string[],
  overviewSummary: string,
  statedIntent?: string,
  repositoryContext?: string
): string {
  const relevantFiles = classified.filter((cf) => cf.tier <= 2);
  const flaggedSet = new Set(flaggedFiles);

  // Split into flagged and non-flagged
  const flagged = relevantFiles.filter((cf) => flaggedSet.has(cf.file.path));
  const notFlagged = relevantFiles.filter((cf) => !flaggedSet.has(cf.file.path));

  const sections: string[] = [];

  // Context from overview
  sections.push("## Context from Overview Pass");
  sections.push("");
  sections.push(`Overall change: ${overviewSummary}`);
  sections.push(`Files flagged for detailed review: ${flagged.length}`);
  sections.push(`Files not flagged (already reviewed): ${notFlagged.length}`);
  sections.push("");

  // Repository context if available
  if (repositoryContext) {
    sections.push(repositoryContext);
    sections.push("");
  }

  // Non-flagged files (just paths for reference)
  if (notFlagged.length > 0) {
    sections.push("## Files NOT Flagged (for reference only)");
    for (const cf of notFlagged) {
      sections.push(`- ${cf.file.path} (${cf.file.status})`);
    }
    sections.push("");
  }

  // Flagged files - FULL content
  sections.push("## Flagged Files (FULL DIFF - analyze in detail)");
  sections.push("");
  for (const cf of flagged) {
    sections.push(formatDiffFile(cf.file));
    sections.push("");
  }

  // Stated intent if provided
  if (statedIntent) {
    sections.push("## Author's Stated Intent");
    sections.push("");
    sections.push(statedIntent);
    sections.push("");
  }

  // Task instruction
  sections.push("---");
  sections.push(`Analyze these FLAGGED files in detail for risks.

REQUIRED OUTPUT:
- overallRisk: "low" | "medium" | "high" | "critical" - highest severity found
- summary: string - actionable summary of findings
- risks: array of detailed risk objects (can be empty)
- confidence: "high" | "medium" | "low"

Each risk MUST have:
- severity, category, description, evidence
- Be SPECIFIC - cite actual code and line numbers`);

  return sections.join("\n");
}

/**
 * Run the deep-dive pass on flagged files.
 */
export async function runDeepDivePass(
  diff: ParsedDiff,
  classified: ClassifiedFile[],
  flaggedFiles: string[],
  overviewSummary: string,
  statedIntent?: string,
  repositoryContext?: string
): Promise<RiskAssessment> {
  // If no files flagged, return empty assessment
  if (flaggedFiles.length === 0) {
    return {
      overallRisk: "low",
      summary: "No files required detailed review - change appears safe.",
      risks: [],
      confidence: "high",
    };
  }

  const userPrompt = buildDeepDivePrompt(
    diff,
    classified,
    flaggedFiles,
    overviewSummary,
    statedIntent,
    repositoryContext
  );

  const response = await chat({
    adapter: anthropicText("claude-sonnet-4-5"),
    systemPrompts: [DEEPDIVE_SYSTEM_PROMPT],
    messages: [{ role: "user", content: userPrompt }],
    outputSchema: wrapSchema(RiskAssessmentSchema),
    temperature: 0.4,
    stream: false,
    maxTokens: 8192,
  });

  return response;
}

// ============================================================================
// Result Merging
// ============================================================================

/**
 * Merge results from overview and deep-dive passes.
 */
export function mergeResults(
  overview: OverviewResult,
  deepDive: RiskAssessment
): { intent: DerivedIntent; risks: RiskAssessment } {
  // Build the final intent from overview
  const intent: DerivedIntent = {
    summary: overview.overviewIntent.summary || overview.summary,
    purpose: overview.overviewIntent.purpose || overview.summary,
    scope: overview.overviewIntent.scope || "mixed",
    affectedAreas: overview.overviewIntent.affectedAreas || [],
  };
  // Suggest reviewing flagged files first (only add if we have flagged files)
  if (overview.flaggedFiles.length > 0) {
    intent.suggestedReviewOrder = overview.flaggedFiles;
  }

  // Merge risks: overview's initial risks + deep-dive's detailed risks
  const allRisks = [...overview.initialRisks, ...deepDive.risks];

  // Deduplicate by description (rough heuristic)
  const seen = new Set<string>();
  const uniqueRisks = allRisks.filter((r) => {
    const key = `${r.category}:${r.description.slice(0, 50)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  uniqueRisks.sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  );

  // Determine overall risk
  const firstRisk = uniqueRisks[0];
  const overallRisk = firstRisk ? firstRisk.severity : "low";

  // Build merged summary
  let summary: string;
  if (uniqueRisks.length === 0) {
    summary = "No significant risks identified in detailed review.";
  } else {
    const criticalCount = uniqueRisks.filter(
      (r) => r.severity === "critical"
    ).length;
    const highCount = uniqueRisks.filter((r) => r.severity === "high").length;
    if (criticalCount > 0) {
      summary = `${criticalCount} critical risk(s) found. ${deepDive.summary}`;
    } else if (highCount > 0) {
      summary = `${highCount} high-severity risk(s) found. ${deepDive.summary}`;
    } else {
      summary = deepDive.summary;
    }
  }

  const risks: RiskAssessment = {
    overallRisk,
    summary,
    risks: uniqueRisks,
    confidence: deepDive.confidence,
  };

  return { intent, risks };
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run two-pass analysis on a medium-sized diff.
 *
 * This is the main entry point for the two-pass strategy:
 * 1. Run overview pass to identify areas of concern
 * 2. Run deep-dive pass on flagged files
 * 3. Merge results into unified intent and risk assessment
 *
 * @param diff - The parsed diff to analyze
 * @param classified - Files classified by tier
 * @param statedIntent - Optional stated intent from the author
 * @param repositoryContext - Optional repository context
 * @returns Combined analysis result with metadata
 */
export async function runTwoPassAnalysis(
  diff: ParsedDiff,
  classified: ClassifiedFile[],
  statedIntent?: string,
  repositoryContext?: string
): Promise<TwoPassAnalysisResult> {
  const relevantFiles = classified.filter((cf) => cf.tier <= 2);

  // Pass 1: Overview
  const overview = await runOverviewPass(
    diff,
    classified,
    statedIntent,
    repositoryContext
  );

  // Pass 2: Deep-dive on flagged files
  const deepDive = await runDeepDivePass(
    diff,
    classified,
    overview.flaggedFiles,
    overview.summary,
    statedIntent,
    repositoryContext
  );

  // Combine results
  const { intent, risks } = mergeResults(overview, deepDive);

  return {
    intent,
    risks,
    metadata: {
      strategy: "two-pass",
      overviewFileCount: relevantFiles.length,
      flaggedFileCount: overview.flaggedFiles.length,
      deepDiveFileCount: overview.flaggedFiles.length,
    },
  };
}
