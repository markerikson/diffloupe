/**
 * Owns the one review that may run in this process (the core keeps its state
 * in module variables). Numbers every event, appends it to the run's
 * `events.jsonl`, and passes it to live subscribers in the same order.
 */
import path from "node:path";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { CancelledError } from "../review/core/runner.ts";
import type { ReviewEvent } from "../review/core/pipeline.ts";
import { executeRun, prepareRun, type ExecutedRun, type PreparedRun } from "../review/run-driver.ts";
import { runDir } from "../review/run-store.ts";
import type { ReviewRun } from "../types/review-run.ts";
import type { RunEvent, StartRunRequest, StoredEvent } from "./types.ts";

export interface ExecuteOptions {
  signal: AbortSignal;
  onProgress: (e: ReviewEvent) => void;
  log: (message: string) => void;
}

export interface RunDriver<P extends { id: string; pending: ReviewRun }> {
  prepare(req: StartRunRequest, log: (message: string) => void): Promise<P>;
  execute(prep: P, opts: ExecuteOptions): Promise<ExecutedRun>;
}

/** A prepared run with the driver's execute step bound to it. */
export interface BoundRun {
  id: string;
  pending: ReviewRun;
  execute(opts: ExecuteOptions): Promise<ExecutedRun>;
}

export type RunPreparer = (req: StartRunRequest, log: (message: string) => void) => Promise<BoundRun>;

export function bindDriver<P extends { id: string; pending: ReviewRun }>(driver: RunDriver<P>): RunPreparer {
  return async (req, log) => {
    const prep = await driver.prepare(req, log);
    return { id: prep.id, pending: prep.pending, execute: (opts) => driver.execute(prep, opts) };
  };
}

export function defaultDriver(defaultRepo: string): RunPreparer {
  return bindDriver<PreparedRun>({
    prepare: (req, log) => prepareRun(req, defaultRepo, log),
    execute: executeRun,
  });
}

export type RunOutcome =
  | { status: "complete"; run: ReviewRun; reviewed: boolean }
  | { status: "cancelled" }
  | { status: "failed"; error: string };

type Listener = (e: StoredEvent) => void;

interface ActiveRun {
  id: string;
  controller: AbortController;
  seq: number;
  subscribers: Set<Listener>;
  pending: ReviewRun;
  done: Promise<RunOutcome>;
}

export class RunBusyError extends Error {
  constructor(readonly activeRunId: string | null) {
    super(activeRunId ? `run ${activeRunId} is still running` : "a run is starting");
    this.name = "RunBusyError";
  }
}

export function eventsPath(id: string): string {
  return path.join(runDir(id), "events.jsonl");
}

/**
 * Events from `events.jsonl`. Lines written before events carried `seq` are
 * numbered by position.
 */
export async function readEvents(id: string): Promise<StoredEvent[]> {
  let raw: string;
  try {
    raw = await readFile(eventsPath(id), "utf8");
  } catch {
    return [];
  }
  const out: StoredEvent[] = [];
  raw.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const e = JSON.parse(line) as StoredEvent;
      out.push(typeof e.seq === "number" ? e : { ...e, seq: i + 1 });
    } catch {
      // A torn final line from a crash.
    }
  });
  return out;
}

export class RunManager {
  private active: ActiveRun | null = null;
  private starting = false;
  private readonly watchers = new Set<(runId: string, e: StoredEvent) => void>();

  constructor(private readonly prepare: RunPreparer) {}

  /** Adds a listener for every event of every run, from the first one. */
  watch(listener: (runId: string, e: StoredEvent) => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  get activeRunId(): string | null {
    return this.active?.id ?? null;
  }

  isActive(id: string): boolean {
    return this.active?.id === id;
  }

  /** The `run.json` written at start, while the run is active. */
  pendingRun(id: string): ReviewRun | undefined {
    return this.active?.id === id ? this.active.pending : undefined;
  }

  /**
   * Resolves the target and starts the run. Resolves once the run is under
   * way; rejects with RunBusyError when a run is active or starting, and with
   * the driver's error (a TargetError for a bad target) when preparing fails.
   */
  async start(req: StartRunRequest): Promise<{ id: string; done: Promise<RunOutcome> }> {
    if (this.active || this.starting) throw new RunBusyError(this.activeRunId);
    this.starting = true;
    const prepLog: string[] = [];
    let prep: BoundRun;
    try {
      prep = await this.prepare(req, (m) => prepLog.push(m));
    } finally {
      this.starting = false;
    }

    const controller = new AbortController();
    const active: ActiveRun = {
      id: prep.id,
      controller,
      seq: 0,
      subscribers: new Set(),
      pending: prep.pending,
      done: Promise.resolve({ status: "cancelled" }),
    };
    this.active = active;
    const emit = (e: RunEvent) => this.emit(active, e);
    for (const message of prepLog) emit({ type: "log", message });

    active.done = prep
      .execute({
        signal: controller.signal,
        onProgress: emit,
        log: (message) => emit({ type: "log", message }),
      })
      .then(
        ({ run, reviewed }): RunOutcome => {
          emit({
            type: "done",
            status: "complete",
            findings: run.findings.length,
            costUsd: run.meta.costUsd,
            wallMs: run.meta.wallMs,
            ...(reviewed ? {} : { noChanges: true }),
          });
          return { status: "complete", run, reviewed };
        },
        (err: unknown): RunOutcome => {
          if (controller.signal.aborted || err instanceof CancelledError) {
            emit({ type: "cancelled" });
            return { status: "cancelled" };
          }
          const message = err instanceof Error ? err.message : String(err);
          emit({ type: "error", message });
          return { status: "failed", error: message };
        },
      )
      .finally(() => {
        if (this.active === active) this.active = null;
      });
    return { id: prep.id, done: active.done };
  }

  /** Aborts the active run. Returns its outcome, or undefined when `id` is not active. */
  cancel(id: string): Promise<RunOutcome> | undefined {
    const active = this.active;
    if (!active || active.id !== id) return undefined;
    active.controller.abort();
    return active.done;
  }

  /**
   * Adds a listener for the active run's events from now on. Returns the last
   * sequence number already emitted and an unsubscribe function, or undefined
   * when `id` is not active.
   */
  subscribe(id: string, listener: Listener): { lastSeq: number; unsubscribe: () => void } | undefined {
    const active = this.active;
    if (!active || active.id !== id) return undefined;
    active.subscribers.add(listener);
    return { lastSeq: active.seq, unsubscribe: () => active.subscribers.delete(listener) };
  }

  private emit(active: ActiveRun, e: RunEvent): void {
    const stored: StoredEvent = { ...e, seq: ++active.seq, at: new Date().toISOString() };
    try {
      appendFileSync(eventsPath(active.id), `${JSON.stringify(stored)}\n`);
    } catch {
      // The run directory was deleted underneath the run; live subscribers still get it.
    }
    const calls = [
      ...[...this.watchers].map((w) => () => w(active.id, stored)),
      ...[...active.subscribers].map((s) => () => s(stored)),
    ];
    for (const call of calls) {
      try {
        call();
      } catch {
        // A broken subscriber must not stop the run.
      }
    }
  }
}
