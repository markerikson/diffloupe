/**
 * `diffloupe review --headless`: run one review in this process without a
 * server, print progress to stderr and a summary (or with `--markdown` the
 * review markdown, or with `--json` the result object) to stdout.
 *
 * Exit codes: 0 complete or skipped, 1 the run failed, 2 the run could not
 * start (bad target, missing tool or credential), 3 `--fail-on` matched,
 * 4 `--max-rounds` skipped the review, 130 cancelled.
 */
import path from "node:path";
import { defaultDriver, RunManager } from "../server/run-manager.ts";
import type { ReviewRun } from "../types/review-run.ts";
import {
  buildResult,
  failsGate,
  writeOutDir,
  writeResult,
  type CiResult,
  type ResultStatus,
  type SkipReason,
} from "./ci-output.ts";
import { formatEvent } from "./format-event.ts";
import { formatDiffSummary, formatRunSummary } from "./format-run.ts";
import type { ReviewCommandOptions } from "./options.ts";
import { readRunMarkdown, requestFromOptions } from "./run-driver.ts";
import { dataDir, loadRun, runDir } from "./run-store.ts";

export { dataDir };

/** Runs one headless review. Returns the process exit code. */
export async function runHeadlessReview(opts: ReviewCommandOptions): Promise<number> {
  const log = (s: string) => console.error(s);
  const manager = new RunManager(defaultDriver(process.cwd()));
  let skippedSlices = 0;
  manager.watch((_id, e) => {
    if (e.type === "budget") skippedSlices = e.skippedSlices;
    const line = formatEvent(e);
    if (line) log(line);
  });

  let started: Awaited<ReturnType<typeof manager.start>>;
  try {
    started = await manager.start(await requestFromOptions(opts));
  } catch (err) {
    log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const stopSignals = stopOnSignal(() => {
    log("\nCancelling: stopping agents and removing the worktree (Ctrl+C again to exit now)...");
    void manager.cancel(started.id);
  });
  const outcome = await started.done;
  stopSignals();

  const dir = runDir(started.id);
  const run = outcome.status === "complete" ? outcome.run : await loadRun(started.id).catch(() => null);
  const status: ResultStatus =
    outcome.status === "complete" ? (outcome.reviewed ? "complete" : "skipped") : outcome.status;
  const roundLimit = outcome.status === "complete" ? outcome.roundLimit : undefined;
  const skipReason: SkipReason | null =
    status !== "skipped" ? null : roundLimit ? "round-limit" : "no-code-files";
  const result = await report(started.id, run, status, skipReason, skippedSlices, opts);
  if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (outcome.status === "cancelled") {
    log(`Run saved as cancelled: ${dir}`);
    return 130;
  }
  if (outcome.status === "failed") {
    log(`Run saved as failed: ${dir}`);
    return 1;
  }
  log(`Run saved: ${dir} (diffloupe runs show ${started.id})\n`);
  if (roundLimit) {
    log(`Not reviewed: round ${roundLimit.round} is past --max-rounds ${roundLimit.maxRounds}`);
    return 4;
  }
  if (!opts.json) {
    if (opts.kind === "diff") {
      process.stdout.write(`${formatDiffSummary(outcome.run)}\n`);
    } else if (outcome.reviewed) {
      const markdown = opts.markdown ? await readRunMarkdown(dir) : undefined;
      process.stdout.write(markdown ?? `${formatRunSummary(outcome.run)}\n`);
    }
  }
  if (opts.failOn && outcome.reviewed && failsGate(outcome.run, opts.failOn)) {
    log(`Failing: a finding is at or above ${opts.failOn}`);
    return 3;
  }
  return 0;
}

/** Builds the result and, with `--out`, copies the run's files and writes result.json there. */
async function report(
  id: string,
  run: ReviewRun | null,
  status: ResultStatus,
  skipReason: SkipReason | null,
  skippedSlices: number,
  opts: ReviewCommandOptions,
): Promise<CiResult> {
  const dir = runDir(id);
  const outDir = opts.out ? path.resolve(opts.out) : null;
  // A run skipped for having no code files still has a payload file: the core
  // writes a "nothing to review" summary for it. Posting that comment is noise,
  // so it is not reported or copied. A run stopped by --max-rounds posts the
  // notice saying why the push was not reviewed.
  const postable = status === "complete" || skipReason === "round-limit";
  const rawPayloads = path.join(dir, "raw", "payloads.json");
  let payloads = postable && (await Bun.file(rawPayloads).exists()) ? rawPayloads : null;
  if (outDir) {
    const written = await writeOutDir(id, outDir, { payloads: postable });
    payloads = written.includes("payloads.json") ? path.join(outDir, "payloads.json") : null;
  }
  const result = buildResult(run, {
    id,
    status,
    runDir: dir,
    outDir,
    payloads,
    skippedSlices,
    ...(opts.github ? { round: await githubRound(dir) } : {}),
    skipReason,
  });
  if (outDir) await writeResult(outDir, result);
  return result;
}

/** The `runs` count the review wrote into the PR's summary marker, from the raw record. */
async function githubRound(dir: string): Promise<number | undefined> {
  try {
    const record = (await Bun.file(path.join(dir, "raw", "record.json")).json()) as { runs?: unknown };
    return typeof record.runs === "number" ? record.runs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Calls `onFirst` on the first Ctrl+C or SIGTERM and exits on the second.
 * Returns a function that removes the handlers.
 */
export function stopOnSignal(onFirst: () => void): () => void {
  let fired = false;
  const handler = () => {
    if (fired) process.exit(130);
    fired = true;
    onFirst();
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
