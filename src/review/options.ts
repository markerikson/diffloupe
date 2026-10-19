/**
 * Options for `diffloupe review`. Type-only, so the root CLI can import it
 * without pulling the review core into the root typecheck.
 */
export interface ReviewCommandOptions {
  /** `diff` for `diffloupe diff`: grouping only, no review agents. */
  kind?: "review" | "diff";
  /** Diff runs: add the walkthrough guide. */
  walkthrough?: boolean;
  /** Target spec; see parseTargetSpec in targets.ts. Defaults to the working tree. */
  target?: string;
  /** Repository to review, from -C. Defaults to the current directory. */
  repo?: string;
  base?: string;
  intent?: string;
  intentFile?: string;
  /** `stage=model-id` pairs; stages are review, coordinator, walkthrough, intent. */
  model?: string[];
  effort?: string;
  /** Per-repo settings file; see settings.ts. */
  config?: string;
  /** Stop starting new slices once the run has cost this many dollars. */
  maxCost?: number;
  /** Review everything even when an earlier run of this target exists. */
  full?: boolean;
  headless?: boolean;
  /** Print the review markdown to stdout instead of the terminal summary. */
  markdown?: boolean;
  host?: string;
  port?: number;
  open?: boolean;
}

export type ReviewModelStage = "review" | "coordinator" | "walkthrough" | "intent";
