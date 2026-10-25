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
  /** Skip the review, before any model call, when it would be a later round than this. Headless exits 4 then. */
  maxRounds?: number;
  /** Review everything even when an earlier run of this target exists. */
  full?: boolean;
  headless?: boolean;
  /** Print the review markdown to stdout instead of the terminal summary. */
  markdown?: boolean;
  /** Pull requests only: keep the GitHub markers and write `payloads.json` for posting. */
  github?: boolean;
  /** Pull requests only: review this commit of the PR instead of its current head. */
  head?: string;
  /** Headless only: copy the run's output files and `result.json` into this directory. */
  out?: string;
  /** Headless only: print `result.json` on stdout and nothing else. */
  json?: boolean;
  /** Headless only: exit 3 when a posted finding is at or above this severity. */
  failOn?: "blocker" | "should-fix" | "nice-to-have" | "question";
  host?: string;
  port?: number;
  open?: boolean;
}

export type ReviewModelStage = "review" | "coordinator" | "walkthrough" | "intent";
