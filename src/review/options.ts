/**
 * Options for `diffloupe review`. Type-only, so the root CLI can import it
 * without pulling the review core into the root typecheck.
 */
export interface ReviewCommandOptions {
  /** Target spec; see parseTargetSpec in targets.ts. Defaults to the working tree. */
  target?: string;
  /** Repository to review, from -C. Defaults to the current directory. */
  repo?: string;
  base?: string;
  intent?: string;
  intentFile?: string;
  /** `stage=model-id` pairs; stages are review, coordinator, walkthrough. */
  model?: string[];
  effort?: string;
  /** Per-repo settings file; see settings.ts. */
  config?: string;
  headless?: boolean;
  /** Print the review markdown to stdout instead of the terminal summary. */
  markdown?: boolean;
}

export type ReviewModelStage = "review" | "coordinator" | "walkthrough";
