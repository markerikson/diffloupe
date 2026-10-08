import { Command } from "commander";
import pc from "picocolors";
import type { ReviewCommandOptions } from "../review/options.js";

interface HeadlessModule {
  runHeadlessReview(opts: ReviewCommandOptions): Promise<number>;
}

// The review layer has its own tsconfig (src/review/tsconfig.json). A
// non-literal specifier keeps the root typecheck from following the import
// into the ported core, which is written to looser compiler settings.
const HEADLESS_MODULE = "../review/headless.ts";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function createReviewCommand(): Command {
  return new Command("review")
    .description("Review changes with the multi-agent reviewer (requires opencode, tilth, git; gh for PRs)")
    .argument(
      "[target]",
      "worktree (default), staged, HEAD, commit:<sha>, range:<a>..<b>, branch:<name>, #<pr>, pr:<n>, or a PR URL",
    )
    .option("-C, --repo <path>", "Repository to review (default: current directory)")
    .option("--base <ref>", "For staged/worktree: diff against merge-base(<ref>, HEAD) instead of HEAD")
    .option("-i, --intent <text>", "Describe the intent of the changes")
    .option("--intent-file <path>", "Read the intent from a file")
    .option("--model <stage=id>", "Model for a stage: review, coordinator, walkthrough (repeatable)", collect, [])
    .option("--effort <level>", "Reasoning effort (low, medium, high)")
    .option("--config <file>", "Per-repo review settings JSON (models, effort, surfaces, extraExcludes)")
    .option("--headless", "Run in the terminal and print the review to stdout", false)
    .action(async (target: string | undefined, options: Omit<ReviewCommandOptions, "target">) => {
      if (!options.headless) {
        console.error(pc.yellow("Server mode arrives in phase 3. Use --headless for now."));
        process.exit(1);
      }
      const mod = (await import(HEADLESS_MODULE)) as HeadlessModule;
      const code = await mod.runHeadlessReview({ ...options, ...(target ? { target } : {}) });
      process.exit(code);
    });
}
