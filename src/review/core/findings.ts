import { type Anchor } from "./lib/hunks.ts";

/**
 * Never worth a slice: generated, vendored or minified content, where every line
 * is machine output. The workflow's size gate carries a matching exclude list,
 * checked against this one by a unit test.
 */
export const SKIP_SLICE = [
  "pnpm-lock.yaml", "package-lock.json", "bun.lock", "yarn.lock", "Cargo.lock", "go.sum",
  ".min.js", ".min.css", ".bundle.js", ".map", "__snapshots__/",
];

/**
 * Prose carries no logic, so it cannot contain the defect classes this review
 * looks for. Reviewing it costs a full slice and can only produce the doc and
 * style feedback the prompt already forbids.
 */
export const DOCS_ONLY = /\.(md|mdx|txt|rst)$|^LICENSE|^\.gitignore$|^\.gitattributes$/;

export function classifyFile(f: string): "skip" | "docs" | "code" {
  if (SKIP_SLICE.some((s) => f.includes(s))) return "skip";
  if (DOCS_ONLY.test(f) || DOCS_ONLY.test(f.split("/").pop() ?? "")) return "docs";
  return "code";
}

export interface Finding {
  file: string;
  line: number;
  end_line?: number;
  severity: "blocker" | "should-fix" | "nice-to-have" | "question";
  category: string;
  title: string;
  /** One or two sentences on what goes wrong. The only part shown unexpanded. */
  impact?: string;
  explanation: string;
  evidence: string;
  confidence: "high" | "medium" | "low";
  /**
   * How much work the fix is. Severity says how much it matters and confidence
   * says how sure the reviewer is; neither answers the question someone asks
   * when triaging ten findings, which is what can be cleared before merging.
   */
  effort?: "quick" | "moderate" | "involved";
  cross_file_refs?: string[];
  /**
   * Other `path:line` places where the same defect occurs and needs the same
   * fix. Unlike `cross_file_refs`, which records what was read as support,
   * these are shown with the finding so the author fixes every copy.
   */
  also_at?: string[] | undefined;
  suggestion?: string;
  suggested_code?: string;
  /**
   * Id of a human's existing comment making the same claim. Set by the
   * coordinator and vetted by `applyDecisions`, never written by a reviewer.
   * A finding carrying one is rendered as a reply into that person's thread
   * instead of as a new comment.
   */
  repeat_of?: number | undefined;
  /**
   * The problem is in code this change did not add or modify, and the change
   * does not make it worse. Set by the reviewer; the coordinator may override.
   * Pre-existing findings have their own cap and never block the change.
   */
  preexisting?: boolean | undefined;
  /** Filled by the pipeline, not the model. */
  _slice?: string;
  /**
   * The current text of lines `line`..`end_line`, read from the head commit so a
   * suggested replacement can be shown as a diff. Absent when there is no
   * checkout to read, or no `suggested_code` to compare against.
   */
  _original?: string;
  /**
   * Where GitHub will accept this comment, computed from the diff at render
   * time. Absent when the diff could not be read, which falls back to trusting
   * the model's own line.
   */
  _anchor?: Anchor;
}
