import { Command } from "commander";
import pc from "picocolors";
import type { DerivedIntent, IntentAlignment, RiskAssessment } from "../types/analysis";
import { formatSummary, formatVerbose } from "./output";
import { getDiff } from "../services/git.js";
import { parseDiff } from "../services/diff-parser.js";
import { classifyDiff } from "../services/diff-loader.js";
import { deriveIntent } from "../prompts/intent.js";
import { assessRisks } from "../prompts/risks.js";
import { alignIntent } from "../prompts/alignment.js";
import { hasAPIKey } from "../services/llm.js";
import { GitError } from "../types/git.js";
import { LLMAPIKeyError, LLMGenerationError } from "../types/llm.js";
import { createPRCommand } from "./pr.js";

export interface AnalyzeOptions {
  target: string;
  verbose: boolean;
  json: boolean;
  force: boolean;
  intent?: string;
  intentFile?: string;
  demo?: boolean;
}

/**
 * Reads stated intent from multiple sources in priority order:
 * 1. --intent "string" CLI arg
 * 2. --intent-file <path> - read from file
 * 3. stdin if piped (non-TTY)
 */
async function resolveStatedIntent(options: AnalyzeOptions): Promise<string | undefined> {
  // Priority 1: CLI argument
  if (options.intent) {
    return options.intent.trim();
  }

  // Priority 2: File path
  if (options.intentFile) {
    const file = Bun.file(options.intentFile);
    if (!(await file.exists())) {
      throw new Error(`Intent file not found: ${options.intentFile}`);
    }
    const content = await file.text();
    return content.trim() || undefined;
  }

  // Priority 3: stdin if piped (non-TTY)
  // Note: Bun.stdin.text() blocks until EOF. This is standard behavior for piped
  // input (e.g., `echo "intent" | diffloupe analyze`), but could hang if stdin
  // is opened but never closed. Not adding a timeout for now since this matches
  // typical CLI tool behavior.
  if (!process.stdin.isTTY) {
    const text = await Bun.stdin.text();
    return text.trim() || undefined;
  }

  return undefined;
}

/**
 * Outputs analysis results in the appropriate format based on options
 */
function outputResults(
  intent: DerivedIntent,
  risks: RiskAssessment,
  options: AnalyzeOptions,
  statedIntent?: string,
  alignment?: IntentAlignment
): void {
  if (options.json) {
    console.log(JSON.stringify({ intent, risks, statedIntent, alignment }, null, 2));
  } else if (options.verbose) {
    console.log(formatVerbose(intent, risks, statedIntent, alignment));
  } else {
    console.log(formatSummary(intent, risks, statedIntent, alignment));
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
  .option("--intent-file <path>", "Read intent from a file")
  .option("--demo", "Show demo output with mock data", false)
  .action(async (target: string, options: Omit<AnalyzeOptions, "target">) => {
    const opts: AnalyzeOptions = { target, ...options };

    // Resolve stated intent from all sources early (before API key check)
    // This allows --intent-file errors to surface before the API key error
    let statedIntent: string | undefined;
    try {
      statedIntent = await resolveStatedIntent(opts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(pc.red(`Error: ${message}`));
      process.exit(1);
    }

    // Demo mode: use mock data
    if (opts.demo) {
      outputResults(mockIntent, mockRisks, opts, statedIntent);
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
      // Pass stated intent as context to both prompts
      const [intent, risks] = await Promise.all([
        deriveIntent(parsed, classified, statedIntent),
        assessRisks(parsed, classified, statedIntent),
      ]);

      // Step 4: Run alignment analysis if stated intent is provided
      let alignment: IntentAlignment | undefined;
      if (statedIntent) {
        console.log(pc.dim("Analyzing intent alignment..."));
        alignment = await alignIntent(statedIntent, intent, parsed, classified);
      }

      // Step 5: Output results
      console.log(""); // blank line before results
      outputResults(intent, risks, opts, statedIntent, alignment);
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

// Register subcommands
program.addCommand(createPRCommand());

export function run() {
  program.parse();
}
