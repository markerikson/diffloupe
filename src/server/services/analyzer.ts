/**
 * Analyzer Service - Core analysis logic extracted from CLI
 *
 * This provides a reusable function that runs the same analysis flow
 * as the CLI, but returns structured results instead of printing output.
 */

import type { DerivedIntent, IntentAlignment, RiskAssessment } from "../../types/analysis.js";
import type { DecompositionStrategy } from "../../services/decomposition/types.js";
import type { AnalysisResult } from "../types.js";
import { getDiff } from "../../services/git.js";
import { parseDiff } from "../../services/diff-parser.js";
import { classifyDiff } from "../../services/diff-loader.js";
import { gatherContext } from "../../services/context.js";
import { deriveIntent } from "../../prompts/intent.js";
import { assessRisks } from "../../prompts/risks.js";
import { alignIntent } from "../../prompts/alignment.js";
import { hasAPIKey } from "../../services/llm.js";
import {
  calculateDiffMetrics,
  selectStrategy,
  runTwoPassAnalysis,
  runFlowBasedAnalysis,
} from "../../services/decomposition/index.js";

/** Options for running analysis */
export interface RunAnalysisOptions {
  /** What to diff: "staged", "HEAD", "commit:abc", etc. */
  target: string;
  /** Optional stated intent from the author */
  statedIntent?: string | undefined;
  /** Working directory for git operations */
  cwd?: string | undefined;
  /** Force a specific decomposition strategy */
  strategy?: DecompositionStrategy | undefined;
  /** Progress callback for status updates */
  onProgress?: ((message: string) => void) | undefined;
}

/** Error thrown when there are no changes to analyze */
export class NoChangesError extends Error {
  constructor(target: string) {
    super(`No changes found for target: ${target}`);
    this.name = "NoChangesError";
  }
}

/** Error thrown when API key is missing */
export class MissingAPIKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY environment variable is not set");
    this.name = "MissingAPIKeyError";
  }
}

/**
 * Run the full analysis pipeline on a diff target.
 *
 * This is the core analysis function that both CLI and server use.
 * It replicates the logic from `src/cli/index.ts` but returns
 * structured results instead of printing to console.
 *
 * @param options - Analysis options
 * @returns Full analysis result
 * @throws NoChangesError if no changes found
 * @throws MissingAPIKeyError if API key not set
 * @throws GitError for git-related errors
 * @throws LLMGenerationError for AI analysis failures
 */
export async function runAnalysis(options: RunAnalysisOptions): Promise<AnalysisResult> {
  const { target, statedIntent, cwd, strategy: forcedStrategy, onProgress } = options;
  const progress = onProgress ?? (() => {});

  // Check for API key before doing any work
  if (!hasAPIKey()) {
    throw new MissingAPIKeyError();
  }

  // Step 1: Get the diff
  progress("Fetching diff...");
  const diffResult = await getDiff(target, cwd);

  // Handle empty diff
  if (!diffResult.hasChanges) {
    throw new NoChangesError(target);
  }

  // Step 2: Parse and classify the diff
  progress("Parsing diff...");
  const parsed = parseDiff(diffResult.diff);
  const classified = classifyDiff(parsed);

  // Step 3: Select decomposition strategy based on diff size
  const metrics = calculateDiffMetrics(parsed, classified);
  const strategySelection = forcedStrategy
    ? { strategy: forcedStrategy, reason: "Forced via API parameter", metrics }
    : selectStrategy(metrics);

  progress(`Found ${parsed.files.length} file(s), ~${metrics.estimatedTokens} tokens`);
  progress(`Strategy: ${strategySelection.strategy}`);

  // Step 4: Gather repository context (sibling files in touched directories)
  const repositoryContext = await gatherContext(parsed, cwd);

  // Step 5: Run analysis based on selected strategy
  let intent: DerivedIntent;
  let risks: RiskAssessment;

  if (strategySelection.strategy === "two-pass") {
    // Two-pass strategy for medium diffs
    progress("Pass 1: Quick overview...");
    const result = await runTwoPassAnalysis(parsed, classified, statedIntent, repositoryContext);
    progress(`Pass 2: Deep-dive on ${result.metadata.flaggedFileCount} flagged file(s)...`);
    intent = result.intent;
    risks = result.risks;
  } else if (strategySelection.strategy === "flow-based" || strategySelection.strategy === "hierarchical") {
    // Flow-based strategy for large diffs (hierarchical falls back to flow-based)
    const result = await runFlowBasedAnalysis(
      parsed,
      classified,
      statedIntent,
      repositoryContext,
      (stage, detail) => {
        if (stage === "detecting") {
          progress("Detecting logical flows...");
        } else if (stage === "analyzing" && detail) {
          progress(detail);
        } else if (stage === "synthesizing") {
          progress("Synthesizing results...");
        }
      }
    );
    progress(`Analyzed ${result.metadata.flowCount} flows across ${result.metadata.totalFileCount} files`);
    intent = result.synthesis.overallIntent;
    risks = result.synthesis.overallRisks;
  } else {
    // Direct analysis (default for small diffs)
    progress("Analyzing with AI...");
    [intent, risks] = await Promise.all([
      deriveIntent(parsed, classified, statedIntent, repositoryContext),
      assessRisks(parsed, classified, statedIntent, repositoryContext),
    ]);
  }

  // Step 6: Run alignment analysis if stated intent is provided
  let alignment: IntentAlignment | undefined;
  if (statedIntent) {
    progress("Analyzing intent alignment...");
    alignment = await alignIntent(statedIntent, intent, parsed, classified, repositoryContext);
  }

  return {
    diff: parsed,
    derivedIntent: intent,
    risks,
    alignment,
    strategy: strategySelection.strategy,
    repositoryContext,
  };
}
