import type { ReviewRun } from "../../types/review-run.ts";

const HAS_COMMITS = new Set<ReviewRun["target"]["kind"]>(["range", "branch", "commit"]);

/**
 * What the change's intent was judged against, as a noun phrase: the PR
 * description, the `--intent` text, the commit messages in the range, or
 * both of the last two. Undefined when nothing was stated, as for staged or
 * worktree changes with no `--intent`.
 */
export function intentSource(run: Pick<ReviewRun, "target" | "intent">): string | undefined {
  if (run.target.kind === "pr") return "the description";
  const commits = HAS_COMMITS.has(run.target.kind);
  if (run.intent.stated) return commits ? "the stated intent and commit messages" : "the stated intent";
  return commits ? "the commit messages" : undefined;
}
