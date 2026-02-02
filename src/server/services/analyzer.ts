/**
 * Analyzer Service - Core analysis logic extracted from CLI
 *
 * This provides a reusable function that runs the same analysis flow
 * as the CLI, but returns structured results instead of printing output.
 */

import type { DerivedIntent, IntentAlignment, RiskAssessment } from "../../types/analysis.js";
import type { DecompositionStrategy } from "../../services/decomposition/types.js";
import type { AnalysisProgress, AnalysisResult, ProgressStatus } from "../types.js";
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
  /** Progress callback for structured status updates */
  onProgress?: ((progress: AnalysisProgress) => void) | undefined;
}

/**
 * Helper to create and emit a progress update
 */
function createProgress(
  status: ProgressStatus,
  percent: number,
  message: string,
  detail?: string
): AnalysisProgress {
  return { status, percent, message, detail };
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
  const emit = (status: ProgressStatus, percent: number, message: string, detail?: string) => {
    onProgress?.(createProgress(status, percent, message, detail));
  };

  // Check for API key before doing any work
  if (!hasAPIKey()) {
    throw new MissingAPIKeyError();
  }

  // Step 1: Get the diff
  emit("fetching_diff", 2, "Fetching diff...");
  const diffResult = await getDiff(target, cwd);

  // Handle empty diff
  if (!diffResult.hasChanges) {
    throw new NoChangesError(target);
  }

  // Step 2: Parse and classify the diff
  emit("parsing", 8, "Parsing diff...");
  const parsed = parseDiff(diffResult.diff);
  const classified = classifyDiff(parsed);

  // Step 3: Select decomposition strategy based on diff size
  const metrics = calculateDiffMetrics(parsed, classified);
  const strategySelection = forcedStrategy
    ? { strategy: forcedStrategy, reason: "Forced via API parameter", metrics }
    : selectStrategy(metrics);

  emit(
    "selecting_strategy",
    12,
    `Strategy: ${strategySelection.strategy}`,
    `${parsed.files.length} file(s), ~${metrics.estimatedTokens} tokens`
  );

  // Step 4: Gather repository context (sibling files in touched directories)
  emit("gathering_context", 15, "Gathering repository context...");
  const repositoryContext = await gatherContext(parsed, cwd);

  // Step 5: Run analysis based on selected strategy
  let intent: DerivedIntent;
  let risks: RiskAssessment;

  if (strategySelection.strategy === "two-pass") {
    // Two-pass strategy for medium diffs
    emit("analyzing_overview", 20, "Quick overview scan...");
    const result = await runTwoPassAnalysis(
      parsed,
      classified,
      statedIntent,
      repositoryContext,
      (phase, detail) => {
        if (phase === "overview") {
          emit("analyzing_overview", 25, "Quick overview scan...");
        } else if (phase === "deepdive") {
          emit("analyzing_deepdive", 50, "Deep-dive analysis...", detail);
        }
      }
    );
    emit("analyzing_deepdive", 80, "Deep-dive analysis...", `${result.metadata.flaggedFileCount} files flagged`);
    intent = result.intent;
    risks = result.risks;
  } else if (strategySelection.strategy === "flow-based" || strategySelection.strategy === "hierarchical") {
    // Flow-based strategy for large diffs (hierarchical falls back to flow-based)
    emit("detecting_flows", 20, "Detecting logical flows...");
    const result = await runFlowBasedAnalysis(
      parsed,
      classified,
      statedIntent,
      repositoryContext,
      (stage, detail, flowIndex, flowCount) => {
        if (stage === "detecting") {
          emit("detecting_flows", 22, "Detecting logical flows...");
        } else if (stage === "analyzing" && flowIndex !== undefined && flowCount !== undefined) {
          // Calculate percent: flows span 25-75%
          const flowPercent = 25 + Math.round((flowIndex / flowCount) * 50);
          emit("analyzing_flow", flowPercent, "Analyzing flows...", detail);
        } else if (stage === "synthesizing") {
          emit("synthesizing", 78, "Synthesizing results...");
        }
      }
    );
    emit("synthesizing", 82, "Synthesizing results...", `${result.metadata.flowCount} flows analyzed`);
    intent = result.synthesis.overallIntent;
    risks = result.synthesis.overallRisks;
  } else {
    // Direct analysis (default for small diffs)
    emit("analyzing_intent", 20, "Analyzing intent...");
    
    // Track which completes first for better progress reporting
    let intentDone = false;
    let risksDone = false;
    
    const intentPromise = deriveIntent(parsed, classified, statedIntent, repositoryContext).then((result) => {
      intentDone = true;
      if (!risksDone) {
        emit("analyzing_risks", 50, "Analyzing risks...", "Intent complete");
      }
      return result;
    });
    
    const risksPromise = assessRisks(parsed, classified, statedIntent, repositoryContext).then((result) => {
      risksDone = true;
      if (!intentDone) {
        emit("analyzing_intent", 50, "Analyzing intent...", "Risks complete");
      }
      return result;
    });
    
    [intent, risks] = await Promise.all([intentPromise, risksPromise]);
    emit("analyzing_risks", 80, "Analysis complete");
  }

  // Step 6: Run alignment analysis if stated intent is provided
  let alignment: IntentAlignment | undefined;
  if (statedIntent) {
    emit("analyzing_alignment", 88, "Checking intent alignment...");
    alignment = await alignIntent(statedIntent, intent, parsed, classified, repositoryContext);
  }

  emit("complete", 100, "Analysis complete");

  return {
    diff: parsed,
    derivedIntent: intent,
    risks,
    alignment,
    strategy: strategySelection.strategy,
    repositoryContext,
  };
}
