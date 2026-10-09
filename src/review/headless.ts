/**
 * `diffloupe review --headless`: run one review in this process without a
 * server, print progress to stderr and a summary (or with `--markdown` the
 * review markdown) to stdout.
 */
import { defaultDriver, RunManager } from "../server/run-manager.ts";
import { formatEvent } from "./format-event.ts";
import { formatRunSummary } from "./format-run.ts";
import type { ReviewCommandOptions } from "./options.ts";
import { readRunMarkdown, requestFromOptions } from "./run-driver.ts";
import { dataDir, runDir } from "./run-store.ts";

export { dataDir };

/** Runs one headless review. Returns the process exit code. */
export async function runHeadlessReview(opts: ReviewCommandOptions): Promise<number> {
  const log = (s: string) => console.error(s);
  const manager = new RunManager(defaultDriver(process.cwd()));
  manager.watch((_id, e) => {
    const line = formatEvent(e);
    if (line) log(line);
  });

  let started: Awaited<ReturnType<typeof manager.start>>;
  try {
    started = await manager.start(await requestFromOptions(opts));
  } catch (err) {
    log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const stopSignals = stopOnSignal(() => {
    log("\nCancelling: stopping agents and removing the worktree (Ctrl+C again to exit now)...");
    void manager.cancel(started.id);
  });
  const outcome = await started.done;
  stopSignals();

  const dir = runDir(started.id);
  if (outcome.status === "cancelled") {
    log(`Run saved as cancelled: ${dir}`);
    return 130;
  }
  if (outcome.status === "failed") {
    log(`Run saved as failed: ${dir}`);
    return 1;
  }
  log(`Run saved: ${dir} (diffloupe runs show ${started.id})\n`);
  if (!outcome.reviewed) return 0;
  const markdown = opts.markdown ? await readRunMarkdown(dir) : undefined;
  process.stdout.write(markdown ?? `${formatRunSummary(outcome.run)}\n`);
  return 0;
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
