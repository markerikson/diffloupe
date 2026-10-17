import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { formatEvent } from "../review/format-event.ts";
import { runHeadlessReview, stopOnSignal } from "../review/headless.ts";
import type { ReviewCommandOptions } from "../review/options.ts";
import { requestFromOptions } from "../review/run-driver.ts";
import { listRuns } from "../review/run-store.ts";
import { run } from "../review/core/lib/proc.ts";
import { openBrowser } from "../server/browser.ts";
import { DEFAULT_HOST, DEFAULT_PORT, startServer, type StartedServer } from "../server/index.ts";
import type { StoredEvent } from "../server/types.ts";
import { loadConfig } from "../services/config.ts";
import { cancelRun, findServers, followRun, postRun, ServerRequestError } from "./client.ts";

/** How long a cancelled run gets to stop its agents and remove its worktree before the process exits anyway. */
const CANCEL_WAIT_MS = 10_000;

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new InvalidArgumentError("must be a port number 1-65535");
  return n;
}

function parseCost(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("must be a positive number of US dollars");
  return n;
}

interface ServeOptions {
  repo?: string;
  host?: string;
  port?: number;
  open?: boolean;
}

function log(message: string): void {
  console.error(message);
}

function printEvent(e: StoredEvent): void {
  const line = formatEvent(e);
  if (line) log(line);
}

async function repoRoot(dir: string): Promise<string | null> {
  const r = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"], { allowFail: true }).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() : null;
}

async function bindSettings(opts: ServeOptions): Promise<{ host: string; port: number }> {
  const config = await loadConfig();
  return { host: opts.host ?? config.host ?? DEFAULT_HOST, port: opts.port ?? config.port ?? DEFAULT_PORT };
}

async function maybeOpen(url: string, open: boolean | undefined): Promise<void> {
  if (open && !(await openBrowser(url))) log(`Could not open a browser; visit ${url}`);
}

function runUrl(base: string, id: string): string {
  return `${base}/runs/${id}`;
}

/** Runs a review on an idle server that is already running. Returns the exit code. */
async function reviewOnServer(base: string, opts: ReviewCommandOptions): Promise<number> {
  let id: string;
  try {
    ({ id } = await postRun(base, await requestFromOptions(opts)));
  } catch (err) {
    if (err instanceof ServerRequestError && err.status === 409) return -1;
    log(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }
  const url = runUrl(base, id);
  log(`DiffLoupe ready at ${url} (running on the server already at ${base})`);
  await maybeOpen(url, opts.open);
  const removeSignals = stopOnSignal(() => {
    log("\nCancelling the run (Ctrl+C again to stop following it)...");
    void cancelRun(base, id);
  });
  const terminal = await followRun(base, id, printEvent);
  removeSignals();
  if (terminal?.type === "done") {
    log(`Results: ${url}`);
    return 0;
  }
  return terminal?.type === "cancelled" ? 130 : 1;
}

/** Starts a server in this process and runs the review on it. Resolves only on exit. */
async function reviewInProcess(opts: ReviewCommandOptions): Promise<number> {
  const req = await requestFromOptions(opts);
  const { host, port } = await bindSettings(opts);
  let server: StartedServer;
  try {
    server = await startServer({ host, port, defaultRepo: (await repoRoot(req.repo ?? process.cwd())) ?? null, log });
  } catch (err) {
    log(pc.red(`Error starting server: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }
  const runs = server.ctx.runs;
  runs.watch((_id, e) => printEvent(e));

  let started: Awaited<ReturnType<typeof runs.start>>;
  try {
    started = await runs.start(req);
  } catch (err) {
    log(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    await server.stop();
    return 1;
  }
  const url = runUrl(server.url, started.id);
  log(pc.green(`DiffLoupe ready at ${url}`));
  await maybeOpen(url, opts.open);

  let running = true;
  let cancelling = false;
  stopOnSignal(() => {
    if (!running) process.exit(0);
    cancelling = true;
    log("\nCancelling: stopping agents and removing the worktree (Ctrl+C again to exit now)...");
    const done = runs.cancel(started.id) ?? Promise.resolve();
    void Promise.race([done, Bun.sleep(CANCEL_WAIT_MS)]).then(() => process.exit(130));
  });
  const outcome = await started.done;
  running = false;
  if (cancelling) return new Promise<number>(() => {});

  if (outcome.status === "complete") {
    log(`Results: ${url}`);
  } else if (outcome.status === "failed") {
    log(`Results (failed run): ${url}`);
  }
  log(pc.dim("Server still running. Press Ctrl+C to stop."));
  return new Promise<number>(() => {});
}

async function runReviewCommand(target: string | undefined, options: Omit<ReviewCommandOptions, "target">) {
  const opts: ReviewCommandOptions = { ...options, ...(target ? { target } : {}) };
  if (opts.headless) process.exit(await runHeadlessReview(opts));

  const { port } = await bindSettings(opts);
  for (const found of await findServers(port)) {
    if (found.health.activeRunId) continue;
    const code = await reviewOnServer(found.base, opts);
    if (code >= 0) process.exit(code);
  }
  process.exit(await reviewInProcess(opts));
}

const TARGET_HELP =
  "worktree (default), staged, a commit (<sha>, HEAD~2, commit:<rev>), a range (<a>..<b>, <a>...<b>), " +
  "a branch (<name>, branch:<name>), #<pr>, pr:<n>, or a PR URL";

export function createReviewCommand(): Command {
  return new Command("review")
    .description("Review changes with the multi-agent reviewer (requires opencode, tilth, git; gh for PRs)")
    .argument(
      "[target]",
      TARGET_HELP,
    )
    .option("-C, --repo <path>", "Repository to review (default: current directory)")
    .option("--base <ref>", "For staged/worktree: diff against merge-base(<ref>, HEAD) instead of HEAD")
    .option("-i, --intent <text>", "Describe the intent of the changes")
    .option("--intent-file <path>", "Read the intent from a file")
    .option("--model <stage=id>", "Model for a stage: review, coordinator, walkthrough (repeatable)", collect, [])
    .option("--effort <level>", "Reasoning effort: the model variant to use, e.g. low, medium, high")
    .option("--config <file>", "Per-repo review settings JSON (models, effort, surfaces, extraExcludes, instructions)")
    .option(
      "--max-cost <usd>",
      "Stop starting new review slices once spending reaches this many US dollars. Slices already running " +
        "finish, so the total can exceed the limit by up to 6 slices at $3 each plus the coordinator and walkthrough " +
        "(default: maxCostUsd from ~/.config/diffloupe/config.json, else no limit)",
      parseCost,
    )
    .option(
      "--full",
      "Review every changed file even when this target was reviewed before (default: a re-review looks only at " +
        "files changed since the last run)",
      false,
    )
    .option("--host <host>", `Address for the server to listen on (default: ${DEFAULT_HOST})`)
    .option("--port <port>", `Port for the server (default: ${DEFAULT_PORT}, or the next free one)`, parsePort)
    .option("--open", "Open the run in a browser", false)
    .option("--headless", "Run in the terminal without a server and print a summary to stdout", false)
    .option("--markdown", "With --headless: print the full review markdown instead of the summary", false)
    .action(runReviewCommand);
}

export function createDiffCommand(): Command {
  return new Command("diff")
    .description(
      "Open a diff grouped by how the code connects, with no review agents (requires git; gh for PRs). " +
        "--walkthrough adds a guide from one model call.",
    )
    .argument(
      "[target]",
      TARGET_HELP,
    )
    .option("-C, --repo <path>", "Repository to diff (default: current directory)")
    .option("--base <ref>", "For staged/worktree: diff against merge-base(<ref>, HEAD) instead of HEAD")
    .option("--walkthrough", "Add the walkthrough guide (one model call; needs opencode and a credential)", false)
    .option("-i, --intent <text>", "With --walkthrough: describe the intent of the changes")
    .option("--intent-file <path>", "With --walkthrough: read the intent from a file")
    .option("--model <walkthrough=id>", "With --walkthrough: the walkthrough model", collect, [])
    .option("--effort <level>", "With --walkthrough: reasoning effort (model variant)")
    .option("--config <file>", "Per-repo review settings JSON (models, effort, extraExcludes)")
    .option("--host <host>", `Address for the server to listen on (default: ${DEFAULT_HOST})`)
    .option("--port <port>", `Port for the server (default: ${DEFAULT_PORT}, or the next free one)`, parsePort)
    .option("--open", "Open the run in a browser", false)
    .option("--headless", "Print the grouped file list to stdout without a server", false)
    .action((target: string | undefined, options: Omit<ReviewCommandOptions, "target" | "kind">) =>
      runReviewCommand(target, { ...options, kind: "diff" }),
    );
}

export function createOpenCommand(): Command {
  return new Command("open")
    .description("Print (or open) the URL of a saved run, starting a server if none is running")
    .argument("[runId]", "Run to open (default: the run list)")
    .option("--last", "Open the most recent run", false)
    .option("--host <host>", `Address for a new server to listen on (default: ${DEFAULT_HOST})`)
    .option("--port <port>", `Port to look for a server on (default: ${DEFAULT_PORT})`, parsePort)
    .option("--open", "Open the URL in a browser", false)
    .action(async (runId: string | undefined, opts: ServeOptions & { last?: boolean }) => {
      let id = runId;
      if (!id && opts.last) {
        id = (await listRuns())[0]?.id;
        if (!id) {
          log("No saved runs.");
          process.exit(1);
        }
      }
      const { host, port } = await bindSettings(opts);
      const existing = (await findServers(port))[0];
      if (existing) {
        const url = id ? runUrl(existing.base, id) : existing.base;
        console.log(url);
        await maybeOpen(url, opts.open);
        process.exit(0);
      }
      await serveForever({ ...opts, host, port }, id);
    });
}

async function serveForever(opts: ServeOptions & { host: string; port: number }, runId?: string): Promise<StartedServer> {
  const dir = path.resolve(opts.repo ?? process.cwd());
  let server: StartedServer;
  try {
    server = await startServer({ host: opts.host, port: opts.port, defaultRepo: await repoRoot(dir), log });
  } catch (err) {
    log(pc.red(`Error starting server: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
  const url = runId ? runUrl(server.url, runId) : server.url;
  log(pc.green(`DiffLoupe ready at ${url}`));
  log(pc.dim("Press Ctrl+C to stop."));
  server.ctx.runs.watch((id, e) => {
    const line = formatEvent(e);
    if (line) log(`${pc.dim(id)} ${line}`);
  });
  stopOnSignal(() => {
    const active = server.ctx.runs.activeRunId;
    if (!active) process.exit(0);
    log("\nCancelling the active run (Ctrl+C again to exit now)...");
    const done = server.ctx.runs.cancel(active) ?? Promise.resolve();
    void Promise.race([done, Bun.sleep(CANCEL_WAIT_MS)]).then(() => process.exit(130));
  });
  await maybeOpen(url, opts.open);
  return server;
}

export function createServeCommand(): Command {
  return new Command("serve")
    .description("Start the DiffLoupe server and keep it running")
    .option("-C, --repo <path>", "Repository runs use when a request names none (default: current directory)")
    .option("--host <host>", `Address to listen on (default: ${DEFAULT_HOST})`)
    .option("--port <port>", `Port (default: ${DEFAULT_PORT}, or the next free one)`, parsePort)
    .option("--open", "Open the server in a browser", false)
    .action(async (opts: ServeOptions) => {
      await serveForever({ ...opts, ...(await bindSettings(opts)) });
    });
}
