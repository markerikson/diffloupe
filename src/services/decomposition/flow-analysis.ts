/**
 * Flow-Based Analysis for Large Diffs
 *
 * This module implements the flow-based analysis strategy for diffs in the 41-80 file range.
 * It builds on flow detection (Phase 3) to run focused analysis on each logical flow,
 * then synthesizes results into a coherent overall analysis.
 *
 * ## Strategy (from design doc)
 *
 * 1. **Flow Detection** (already implemented in flow-detection.ts):
 *    - Identify 3-8 logical flows from the diff
 *    - Each file belongs to exactly one flow
 *
 * 2. **Per-Flow Analysis** (this module):
 *    - Filter diff to only include files in the flow
 *    - Reuse deriveIntent() and assessRisks() with filtered diff
 *    - Include flow context in prompts
 *    - Run flows in parallel (with concurrency limit)
 *
 * 3. **Synthesis** (this module):
 *    - Combine all flow results
 *    - Produce unified intent summary
 *    - Merge and deduplicate risks
 *    - Identify cross-flow concerns
 *
 * ## Key Design Decisions
 *
 * - Reuse existing intent/risk analysis functions (don't reinvent)
 * - Run flows in parallel for performance (limit concurrent to avoid rate limits)
 * - Synthesis is a separate LLM call for coherent results
 */

import { chat } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { type } from "arktype";

import type { ParsedDiff } from "../../types/diff.js";
import type { ClassifiedFile } from "../../types/loader.js";
import type {
  DerivedIntent,
  RiskAssessment,
  IntentAlignment,
  Risk,
} from "../../types/analysis.js";
import { wrapSchema } from "../../utils/schema-compat.js";

import {
  detectFlows,
  getFilesForFlow,
  type DetectedFlow,
} from "./flow-detection.js";

import { deriveIntent } from "../../prompts/intent.js";
import { assessRisks } from "../../prompts/risks.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of analyzing a single flow.
 */
export interface FlowAnalysisResult {
  /** The flow that was analyzed */
  flow: DetectedFlow;
  /** Derived intent for this flow */
  intent: DerivedIntent;
  /** Risk assessment for this flow */
  risks: RiskAssessment;
}

/**
 * Complete result of flow-based analysis.
 */
export interface FlowBasedAnalysisResult {
  /** Per-flow analysis results */
  flows: FlowAnalysisResult[];
  /** Synthesized overall analysis */
  synthesis: {
    /** Overall intent derived from all flows */
    overallIntent: DerivedIntent;
    /** Overall risk assessment from all flows */
    overallRisks: RiskAssessment;
    /** Alignment with stated intent (if provided) */
    alignment?: IntentAlignment;
  };
  /** Metadata about the analysis */
  metadata: {
    strategy: "flow-based";
    /** Total files analyzed */
    totalFileCount: number;
    /** Number of flows detected */
    flowCount: number;
    /** Number of uncategorized files */
    uncategorizedCount: number;
    /** Per-flow file counts */
    flowFileCounts: { name: string; fileCount: number }[];
  };
}

// ============================================================================
// Synthesis Schema
// ============================================================================

/**
 * Schema for the synthesis LLM response.
 * Takes all flow results and produces unified analysis.
 */
const SynthesisResponseSchema = type({
  /** Combined summary of all flows */
  summary: "string",
  /** Unified purpose across all flows */
  purpose: "string",
  /** Overall scope (feature, bugfix, etc.) */
  scope: "'feature' | 'bugfix' | 'refactor' | 'config' | 'docs' | 'test' | 'mixed'",
  /** All affected areas (deduplicated) */
  affectedAreas: "string[]",
  /** Suggested review order (flows first, then files within) */
  "suggestedReviewOrder?": "string[]",
  /** Overall risk level */
  overallRisk: "'low' | 'medium' | 'high' | 'critical'",
  /** Risk summary across all flows */
  riskSummary: "string",
  /** Any cross-flow concerns (risks that span multiple flows) */
  crossFlowConcerns: "string[]",
  /** Confidence in the synthesized analysis */
  confidence: "'high' | 'medium' | 'low'",
});

// ============================================================================
// Constants
// ============================================================================

/** Max concurrent flow analyses to avoid rate limits */
const MAX_CONCURRENT_FLOWS = 3;

// ============================================================================
// Per-Flow Analysis
// ============================================================================

/**
 * Filter a ParsedDiff to only include files in a specific flow.
 */
export function filterDiffForFlow(
  diff: ParsedDiff,
  flow: DetectedFlow
): ParsedDiff {
  const flowPaths = new Set(flow.files);
  return {
    files: diff.files.filter((f) => flowPaths.has(f.path)),
  };
}

/**
 * Filter classified files to only those in a specific flow.
 */
export function filterClassifiedForFlow(
  classified: ClassifiedFile[],
  flow: DetectedFlow
): ClassifiedFile[] {
  return getFilesForFlow(flow, classified);
}

/**
 * Build additional context about which flow we're analyzing.
 * This is prepended to the repository context to help the LLM understand scope.
 */
function buildFlowContextPrefix(flow: DetectedFlow, totalFlows: number): string {
  return `## Flow Context

This analysis is for the "${flow.name}" flow (${flow.files.length} files, priority ${flow.priority}/${totalFlows}).

**Flow description:** ${flow.description}

Focus your analysis on this specific concern. Other flows in this diff will be analyzed separately.

`;
}

/**
 * Analyze a single flow.
 *
 * This filters the diff to only include the flow's files, then runs
 * the standard intent and risk analysis.
 *
 * @param flow - The detected flow to analyze
 * @param diff - The full parsed diff
 * @param classified - All classified files
 * @param totalFlows - Total number of flows (for context)
 * @param statedIntent - Optional stated intent
 * @param repositoryContext - Optional repository context
 */
export async function analyzeFlow(
  flow: DetectedFlow,
  diff: ParsedDiff,
  classified: ClassifiedFile[],
  totalFlows: number,
  statedIntent?: string,
  repositoryContext?: string
): Promise<FlowAnalysisResult> {
  // Filter diff and classified files to just this flow
  const flowDiff = filterDiffForFlow(diff, flow);
  const flowClassified = filterClassifiedForFlow(classified, flow);

  // Build flow-specific context
  const flowContext = buildFlowContextPrefix(flow, totalFlows);
  const fullContext = repositoryContext
    ? `${flowContext}${repositoryContext}`
    : flowContext;

  // Run intent and risk analysis in parallel
  const [intent, risks] = await Promise.all([
    deriveIntent(flowDiff, flowClassified, statedIntent, fullContext),
    assessRisks(flowDiff, flowClassified, statedIntent, fullContext),
  ]);

  return {
    flow,
    intent,
    risks,
  };
}

/**
 * Run analysis on all flows with concurrency limit.
 *
 * Flows are processed in priority order (highest priority first).
 * Uses a simple concurrency limiter to avoid overwhelming the API.
 *
 * @param flows - Detected flows (should already be sorted by priority)
 * @param diff - The full parsed diff
 * @param classified - All classified files
 * @param statedIntent - Optional stated intent
 * @param repositoryContext - Optional repository context
 * @param onProgress - Optional callback for progress updates
 */
export async function analyzeAllFlows(
  flows: DetectedFlow[],
  diff: ParsedDiff,
  classified: ClassifiedFile[],
  statedIntent?: string,
  repositoryContext?: string,
  onProgress?: (flowIndex: number, flowName: string, total: number) => void
): Promise<FlowAnalysisResult[]> {
  const results: FlowAnalysisResult[] = [];
  const totalFlows = flows.length;

  // Process flows with concurrency limit
  for (let i = 0; i < flows.length; i += MAX_CONCURRENT_FLOWS) {
    const batch = flows.slice(i, i + MAX_CONCURRENT_FLOWS);

    const batchResults = await Promise.all(
      batch.map(async (flow, batchIndex) => {
        const flowIndex = i + batchIndex;
        // Report progress
        if (onProgress) {
          onProgress(flowIndex, flow.name, totalFlows);
        }

        return analyzeFlow(
          flow,
          diff,
          classified,
          totalFlows,
          statedIntent,
          repositoryContext
        );
      })
    );

    results.push(...batchResults);
  }

  return results;
}

// ============================================================================
// Synthesis
// ============================================================================

const SYNTHESIS_SYSTEM_PROMPT = `You are an expert code reviewer synthesizing analysis from multiple code flows.

You've received individual analyses for different logical flows (groups of related files) in a large diff. Your task is to:

1. **Synthesize intent** - Combine the individual flow intents into a coherent overall understanding
2. **Merge risks** - Identify the most important risks across all flows, note cross-flow concerns
3. **Identify patterns** - Look for patterns that span multiple flows (e.g., consistent error handling, shared security concerns)

## Key Principles

- Be CONCISE - this is a summary, not a repetition of all findings
- Focus on the BIG PICTURE - what is this change as a whole trying to accomplish?
- Highlight CROSS-FLOW concerns - risks that span multiple flows are often the most important
- Don't just concatenate - SYNTHESIZE into a coherent narrative

## Severity Calibration

When determining overall risk:
- Use the HIGHEST severity from any flow as the baseline
- Elevate if multiple flows have high-severity risks (compounding concern)
- Cross-flow risks (issues that span boundaries) may warrant higher severity`;

/**
 * Build the synthesis prompt from flow analysis results.
 */
export function buildSynthesisPrompt(
  flowResults: FlowAnalysisResult[],
  statedIntent?: string
): string {
  const sections: string[] = [];

  // Overview
  sections.push("## Flow Analysis Summary");
  sections.push("");
  sections.push(`Total flows analyzed: ${flowResults.length}`);
  sections.push(
    `Total files: ${flowResults.reduce((sum, fr) => sum + fr.flow.files.length, 0)}`
  );
  sections.push("");

  // Each flow's analysis
  for (const fr of flowResults) {
    sections.push(`### Flow: ${fr.flow.name} (Priority ${fr.flow.priority})`);
    sections.push(`**Files:** ${fr.flow.files.length}`);
    sections.push(`**Description:** ${fr.flow.description}`);
    sections.push("");
    sections.push("**Intent:**");
    sections.push(`- Summary: ${fr.intent.summary}`);
    sections.push(`- Purpose: ${fr.intent.purpose}`);
    sections.push(`- Scope: ${fr.intent.scope}`);
    sections.push(`- Affected Areas: ${fr.intent.affectedAreas.join(", ")}`);
    sections.push("");
    sections.push("**Risks:**");
    sections.push(`- Overall: ${fr.risks.overallRisk}`);
    sections.push(`- Summary: ${fr.risks.summary}`);
    if (fr.risks.risks.length > 0) {
      sections.push(`- Individual risks (${fr.risks.risks.length}):`);
      for (const risk of fr.risks.risks.slice(0, 5)) {
        // Show up to 5 risks per flow
        sections.push(
          `  - [${risk.severity}] ${risk.category}: ${risk.description}`
        );
      }
      if (fr.risks.risks.length > 5) {
        sections.push(`  - ... and ${fr.risks.risks.length - 5} more`);
      }
    } else {
      sections.push("- No significant risks identified");
    }
    sections.push("");
  }

  // Stated intent if provided
  if (statedIntent) {
    sections.push("## Author's Stated Intent");
    sections.push("");
    sections.push(statedIntent);
    sections.push("");
    sections.push("Consider how well the combined flows achieve this intent.");
    sections.push("");
  }

  // Task instruction
  sections.push("---");
  sections.push(`Synthesize these flow analyses into a unified assessment.

REQUIRED OUTPUT:
- summary: string - 1-2 sentence summary of what the ENTIRE diff accomplishes
- purpose: string - the overall WHY behind all these changes
- scope: "feature" | "bugfix" | "refactor" | "config" | "docs" | "test" | "mixed"
- affectedAreas: string[] - all areas affected (deduplicated and consolidated)
- suggestedReviewOrder: string[] - suggested order to review files (optional)
- overallRisk: "low" | "medium" | "high" | "critical" - highest severity across all flows
- riskSummary: string - actionable summary of risks across all flows
- crossFlowConcerns: string[] - risks or issues that span multiple flows
- confidence: "high" | "medium" | "low"

Focus on synthesis - what does this change mean AS A WHOLE?`);

  return sections.join("\n");
}

/**
 * Synthesize flow results into overall analysis.
 *
 * Takes all flow analysis results and produces:
 * - Unified intent summary
 * - Merged and deduplicated risks
 * - Cross-flow concerns identified
 *
 * @param flowResults - Results from analyzing each flow
 * @param statedIntent - Optional stated intent
 */
export async function synthesizeFlowResults(
  flowResults: FlowAnalysisResult[],
  statedIntent?: string
): Promise<FlowBasedAnalysisResult["synthesis"]> {
  const userPrompt = buildSynthesisPrompt(flowResults, statedIntent);

  const response = await chat({
    adapter: anthropicText("claude-sonnet-4-5"),
    systemPrompts: [SYNTHESIS_SYSTEM_PROMPT],
    messages: [{ role: "user", content: userPrompt }],
    outputSchema: wrapSchema(SynthesisResponseSchema),
    temperature: 0.3,
    stream: false,
    maxTokens: 4096,
  });

  // Merge all risks from all flows
  const allRisks: Risk[] = flowResults.flatMap((fr) => fr.risks.risks);

  // Deduplicate risks by description prefix
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

  // Build overall intent
  const overallIntent: DerivedIntent = {
    summary: response.summary,
    purpose: response.purpose,
    scope: response.scope,
    affectedAreas: response.affectedAreas,
    suggestedReviewOrder: response.suggestedReviewOrder,
  };

  // Build overall risks
  const overallRisks: RiskAssessment = {
    overallRisk: response.overallRisk,
    summary: response.riskSummary,
    risks: uniqueRisks,
    confidence: response.confidence,
  };

  return {
    overallIntent,
    overallRisks,
    // Note: alignment would be computed separately if needed
  };
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run flow-based analysis on a large diff.
 *
 * This is the main entry point for the flow-based strategy:
 * 1. Detect flows in the diff
 * 2. Analyze each flow in parallel
 * 3. Synthesize results into unified analysis
 *
 * @param diff - The parsed diff to analyze
 * @param classified - Files classified by tier
 * @param statedIntent - Optional stated intent from the author
 * @param repositoryContext - Optional repository context
 * @param onProgress - Optional callback for progress updates
 * @returns Complete flow-based analysis result
 */
export async function runFlowBasedAnalysis(
  diff: ParsedDiff,
  classified: ClassifiedFile[],
  statedIntent?: string,
  repositoryContext?: string,
  onProgress?: (stage: string, detail?: string) => void
): Promise<FlowBasedAnalysisResult> {
  // Step 1: Detect flows
  if (onProgress) {
    onProgress("detecting", "Identifying logical flows in diff...");
  }
  const flowDetection = await detectFlows(diff, classified);

  // Handle edge case: no flows detected
  if (flowDetection.flows.length === 0) {
    // Fall back to treating entire diff as one flow
    const singleFlow: DetectedFlow = {
      name: "All Changes",
      description: "All changes in this diff",
      files: classified.filter((cf) => cf.tier <= 2).map((cf) => cf.file.path),
      priority: 1,
    };
    flowDetection.flows = [singleFlow];
    flowDetection.uncategorized = [];
  }

  // Step 2: Analyze each flow
  const flowProgressCallback = onProgress
    ? (index: number, name: string, total: number) => {
        onProgress("analyzing", `Flow ${index + 1}/${total}: ${name}`);
      }
    : undefined;

  const flowResults = await analyzeAllFlows(
    flowDetection.flows,
    diff,
    classified,
    statedIntent,
    repositoryContext,
    flowProgressCallback
  );

  // Step 3: Synthesize results
  if (onProgress) {
    onProgress("synthesizing", "Combining flow analyses...");
  }
  const synthesis = await synthesizeFlowResults(flowResults, statedIntent);

  // Build metadata
  const metadata: FlowBasedAnalysisResult["metadata"] = {
    strategy: "flow-based",
    totalFileCount: classified.filter((cf) => cf.tier <= 2).length,
    flowCount: flowDetection.flows.length,
    uncategorizedCount: flowDetection.uncategorized.length,
    flowFileCounts: flowDetection.flows.map((f) => ({
      name: f.name,
      fileCount: f.files.length,
    })),
  };

  return {
    flows: flowResults,
    synthesis,
    metadata,
  };
}
