import { Command } from "commander";
import pc from "picocolors";
import type { DerivedIntent, RiskAssessment } from "../types/analysis";
import { formatSummary, formatVerbose } from "./output";
import { getDiff } from "../services/git.js";
import { parseDiff } from "../services/diff-parser.js";
import { classifyDiff } from "../services/diff-loader.js";
import { deriveIntent } from "../prompts/intent.js";
import { assessRisks } from "../prompts/risks.js";
import { hasAPIKey } from "../services/llm.js";
import { GitError } from "../types/git.js";
import { LLMAPIKeyError, LLMGenerationError } from "../types/llm.js";

export interface AnalyzeOptions {
  target: string;
  verbose: boolean;
  json: boolean;
  force: boolean;
  intent?: string;
  demo?: boolean;
}

/**
 * Outputs analysis results in the appropriate format based on options
 */
function outputResults(
  intent: DerivedIntent,
  risks: RiskAssessment,
  options: AnalyzeOptions
): void {
  if (options.json) {
    console.log(JSON.stringify({ intent, risks }, null, 2));
  } else if (options.verbose) {
    console.log(formatVerbose(intent, risks));
  } else {
    console.log(formatSummary(intent, risks));
  }
}

const program = new Command();

program
  .name("diffloupe")
  .description("AI-powered diff analysis tool")
  .version("0.1.0");

// Mock data for demo mode
const mockIntent: DerivedIntent = {
  summary: "Adds rate limiting middleware to protect API endpoints from abuse",
  purpose: "Prevents API abuse and ensures fair usage across tenants by limiting requests per IP",
  scope: "feature",
  affectedAreas: ["API middleware", "authentication", "rate limiting"],
  suggestedReviewOrder: [
    "src/middleware/rateLimit.ts",
    "src/config/limits.ts",
    "src/routes/api.ts",
    "src/tests/rateLimit.test.ts",
  ],
};

const mockRisks: RiskAssessment = {
  overallRisk: "medium",
  summary: "One medium-severity issue with error handling; otherwise looks good",
  confidence: "high",
  risks: [
    {
      severity: "medium",
      category: "error-handling",
      description: "Rate limit errors return 500 instead of 429 status code",
      evidence: "Line 45: catch block uses generic error response without setting status",
      file: "src/middleware/rateLimit.ts",
      mitigation: "Return 429 Too Many Requests with Retry-After header",
    },
    {
      severity: "low",
      category: "performance",
      description: "Redis lookup on every request may add latency",
      evidence: "No caching of rate limit state between checks",
      file: "src/middleware/rateLimit.ts",
    },
    {
      severity: "low",
      category: "test-coverage",
      description: "Missing test for concurrent request handling",
      evidence: "Tests only cover sequential requests, not race conditions",
      file: "src/tests/rateLimit.test.ts",
    },
  ],
};

program
  .command("analyze")
  .description("Analyze code changes with AI assistance")
  .argument("[target]", "What to diff: staged, HEAD, HEAD~N, or commit range", "staged")
  .option("-v, --verbose", "Show detailed output", false)
  .option("--json", "Output results as JSON", false)
  .option("-f, --force", "Skip cache and force fresh analysis", false)
  .option("-i, --intent <intent>", "Describe the intent of the changes")
  .option("--demo", "Show demo output with mock data", false)
  .action(async (target: string, options: Omit<AnalyzeOptions, "target">) => {
    const opts: AnalyzeOptions = { target, ...options };

    // Demo mode: use mock data
    if (opts.demo) {
      outputResults(mockIntent, mockRisks, opts);
      return;
    }

    // Check for API key before doing any work
    if (!hasAPIKey()) {
      console.error(
        pc.red("Error: ANTHROPIC_API_KEY environment variable is not set.\n") +
          pc.dim("Set it in your .env file or export it in your shell:\n") +
          pc.dim("  export ANTHROPIC_API_KEY=sk-ant-...\n\n") +
          pc.dim("Or use --demo to see example output without an API key.")
      );
      process.exit(1);
    }

    try {
      // Step 1: Get the diff
      console.log(pc.dim(`Fetching ${opts.target} diff...`));
      const diffResult = await getDiff(opts.target);

      // Handle empty diff
      if (!diffResult.hasChanges) {
        console.log(pc.yellow("\nNo changes found."));
        if (opts.target === "staged") {
          console.log(
            pc.dim("Stage some changes with 'git add' first, or try:\n") +
              pc.dim("  diffloupe analyze HEAD    # all uncommitted changes\n") +
              pc.dim("  diffloupe analyze branch:main  # compare to main")
          );
        }
        return;
      }

      // Step 2: Parse and classify the diff
      console.log(pc.dim("Parsing diff..."));
      const parsed = parseDiff(diffResult.diff);
      const classified = classifyDiff(parsed);

      console.log(
        pc.dim(`Found ${parsed.files.length} file(s), analyzing with AI...`)
      );

      // Step 3: Run intent and risk analysis in parallel
      const [intent, risks] = await Promise.all([
        deriveIntent(parsed, classified),
        assessRisks(parsed, classified),
      ]);

      // Step 4: Output results
      console.log(""); // blank line before results
      outputResults(intent, risks, opts);
    } catch (error) {
      // Handle specific error types with friendly messages
      if (error instanceof GitError) {
        console.error(pc.red(`Git error: ${error.message}`));
        if (error.code === "NOT_A_REPO") {
          console.error(pc.dim("Run this command from within a git repository."));
        }
        process.exit(1);
      }

      if (error instanceof LLMAPIKeyError) {
        console.error(
          pc.red("Error: Invalid or missing API key.\n") +
            pc.dim("Check that your ANTHROPIC_API_KEY is correct.")
        );
        process.exit(1);
      }

      if (error instanceof LLMGenerationError) {
        console.error(
          pc.red("Error: AI analysis failed.\n") +
            pc.dim(error.message)
        );
        process.exit(1);
      }

      // Unknown error
      const message = error instanceof Error ? error.message : String(error);
      console.error(pc.red(`Error: ${message}`));
      process.exit(1);
    }
  });

export function run() {
  program.parse();
}
