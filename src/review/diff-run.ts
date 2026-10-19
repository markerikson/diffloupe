/**
 * A diff run: the review pipeline's deterministic grouping with no review
 * agents, no worktree and, unless a walkthrough is asked for, no model call.
 * Source is read from git objects in the user's clone.
 */
import path from "node:path";
import { groupChanges } from "./core/change-groups.ts";
import {
  ARTIFACTS,
  EFFORT_AUX,
  MODEL_WALK,
  OUT,
  WALK_BUDGET,
  WALK_DIFF_TOKENS,
  applyConfig,
  resetRunState,
  setRunState,
  type ReviewConfig,
} from "./core/config.ts";
import { gatherIntent, gitText } from "./core/context.ts";
import { classifyFile } from "./core/findings.ts";
import { projectFilesAtCommit } from "./core/lib/git-objects.ts";
import { groupTitles } from "./core/lib/group-title.ts";
import { compactDeletedFiles } from "./core/lib/hunks.ts";
import { ensureDir, removeIfPresent, writeText } from "./core/lib/io.ts";
import type { Target } from "./core/lib/target.ts";
import { crossGroupLinkLines, groupLinkLines, selectWalkFiles, sketchFiles, sketchLine } from "./core/lib/walk-input.ts";
import type { ReviewEvent, RunReviewResult } from "./core/pipeline.ts";
import { walkthroughPrompt, type ReviewUnit, type Walkthrough } from "./core/prompts.ts";
import { agent, CancelledError, killAgents, resetOpenCodeConfig } from "./core/runner.ts";

export interface RunDiffOptions {
  /** The local clone whose object store holds `target.base` and `target.head`. */
  repo: string;
  target: Target;
  tag: string;
  config?: Partial<ReviewConfig>;
  /** Add the walkthrough guide: one model call with no file tools. */
  walkthrough?: boolean;
  /** Extra statement of intent for the walkthrough. */
  intent?: string;
  signal?: AbortSignal;
  onProgress?: (event: ReviewEvent) => void;
}

export type RunDiffResult = Pick<RunReviewResult, "record" | "units" | "byClass" | "costUsd" | "wallMs">;

/** Same module-level state as `runReview`, so the two must not overlap in one process. */
export async function runDiff(options: RunDiffOptions): Promise<RunDiffResult> {
  if (options.config) applyConfig(options.config);
  const { signal } = options;
  if (signal?.aborted) throw new CancelledError();
  const onAbort = () => void killAgents();
  signal?.addEventListener("abort", onAbort, { once: true });
  setRunState({
    subject: options.repo,
    repoName: options.target.slug ?? path.basename(options.repo),
    ...(signal ? { signal } : {}),
  });
  try {
    return await diffMain(options);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await killAgents();
    resetRunState();
    resetOpenCodeConfig();
  }
}

async function diffMain(options: RunDiffOptions): Promise<RunDiffResult> {
  const emit = (e: ReviewEvent) => options.onProgress?.(e);
  const checkAbort = () => {
    if (options.signal?.aborted) throw new CancelledError();
  };
  const started = Date.now();
  const { base, head, pr, slug } = options.target;
  const range = `${base}..${head}`;

  emit({ type: "stage", stage: "grouping" });
  const changed = (await gitText(["diff", "--name-only", range])).trim().split("\n").filter(Boolean);
  const byClass = { skip: [] as string[], docs: [] as string[], code: [] as string[] };
  for (const f of changed) byClass[classifyFile(f)].push(f);
  const done = (units: ReviewUnit[], record: Record<string, unknown> | null = null, costUsd = 0): RunDiffResult => ({
    record,
    units,
    byClass,
    costUsd,
    wallMs: Date.now() - started,
  });
  // An empty pathspec means every file, so a change with no code files stops here.
  if (!byClass.code.length) {
    emit({ type: "units", units: [], byClass });
    return done([]);
  }

  const { wholeDiff, diffstat, diffU0, fileTokens, facts, links, grouping } = await groupChanges({
    base,
    head,
    files: byClass.code,
    source: (preload) => projectFilesAtCommit(options.repo, head, preload),
  });
  const titles = groupTitles(grouping.groups, (f) => fileTokens.get(f) ?? 0);
  const units: ReviewUnit[] = grouping.groups.map((g, i) => ({
    id: g.id,
    title: titles[i] ?? g.id,
    files: g.files,
    priority: i + 1,
  }));
  emit({ type: "units", units, byClass });
  checkAbort();
  if (!options.walkthrough) return done(units);

  emit({ type: "stage", stage: "walkthrough" });
  await ensureDir(OUT);
  await ensureDir(path.join(ARTIFACTS, "prompts"));
  await ensureDir(path.join(ARTIFACTS, "logs"));
  await writeText(path.join(ARTIFACTS, ".gitignore"), "*\n");
  const intent = await gatherIntent(slug, pr, base, head, options.intent);

  const walkTag = `${options.tag}-walk`;
  const walkOut = path.join(OUT, `${walkTag}.json`);
  await removeIfPresent(walkOut);
  const { shown, sketched } = selectWalkFiles(units, fileTokens, WALK_DIFF_TOKENS);
  const walkDiff = sketched.length
    ? compactDeletedFiles(await gitText(["diff", range, "--", ...shown]), base)
    : wholeDiff;
  const sketches = sketchFiles(diffU0, facts);
  const wp = walkthroughPrompt({
    diffstat,
    diff: walkDiff,
    sketches: sketched.map((f) => sketchLine(sketches.get(f) ?? { file: f, added: 0, removed: 0, defines: [], touches: [] })),
    crossLinks: crossGroupLinkLines(units, links),
    intent,
    unitSummary: units
      .map((u) => {
        const linked = groupLinkLines(u.files, links);
        return (
          `**${u.title}** (${u.id})\n${u.files.map((f) => `  - ${f}`).join("\n")}` +
          (linked.length ? `\n  Links: ${linked.join("; ")}` : "")
        );
      })
      .join("\n\n"),
    docsFiles: byClass.docs,
    registry: "",
    outFile: walkOut,
  });
  await writeText(path.join(ARTIFACTS, "prompts", `${walkTag}.txt`), wp);
  // A failed walkthrough still leaves a useful diff run, so it is reported, not thrown.
  const walked = await agent(wp, {
    budget: WALK_BUDGET,
    outFile: walkOut,
    tag: walkTag,
    model: MODEL_WALK,
    effort: EFFORT_AUX,
    tools: "none",
  }).catch((err: unknown) => {
    checkAbort();
    emit({ type: "log", message: `  walkthrough failed: ${err instanceof Error ? err.message : String(err)}` });
    return { costUsd: 0, payload: null };
  });
  checkAbort();
  emit({ type: "cost", totalUsd: walked.costUsd });
  const walkthrough = (walked.payload ?? undefined) as Walkthrough | undefined;
  if (!walkthrough) emit({ type: "log", message: "  walkthrough returned no guide" });
  const wallMs = Date.now() - started;
  return done(
    units,
    walkthrough ? { walkthrough, wallMs, totalCostUsd: walked.costUsd } : null,
    walked.costUsd,
  );
}
