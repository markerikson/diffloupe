import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "bun:test";
import { CancelledError } from "../review/core/runner.ts";
import { loadFixture } from "../review/__fixtures__/load.ts";
import { createRunDir, writeRun } from "../review/run-store.ts";
import type { ExecutedRun } from "../review/run-driver.ts";
import type { ReviewRun } from "../types/review-run.ts";
import type { ServerContext } from "./context.ts";
import type { RunEvent } from "./types.ts";
import { bindDriver, RunManager, type RunDriver } from "./run-manager.ts";

/** Points the run store at a temp directory for the file's tests. */
export function useTempDataDir(): void {
  let tmp = "";
  const saved = process.env.XDG_DATA_HOME;
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "diffloupe-server-"));
    process.env.XDG_DATA_HOME = tmp;
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
    await rm(tmp, { recursive: true, force: true });
  });
}

export interface FakePrep {
  id: string;
  pending: ReviewRun;
}

/**
 * A driver whose runs emit whatever the test pushes and finish when the test
 * says so. Cancelling rejects the run with CancelledError.
 */
let fakeRunCount = 0;

export class FakeDriver implements RunDriver<FakePrep> {
  emit: (e: RunEvent) => void = () => {};
  private settle: { resolve: (r: ExecutedRun) => void; reject: (err: unknown) => void } | null = null;
  prepareError: Error | null = null;

  async prepare(): Promise<FakePrep> {
    if (this.prepareError) throw this.prepareError;
    const base = loadFixture("worktree").build();
    const id = `fake-${++fakeRunCount}`;
    const pending: ReviewRun = { ...base, id, status: "running", findings: [] };
    await createRunDir(id);
    await writeRun(pending);
    return { id, pending };
  }

  execute(
    _prep: FakePrep,
    opts: { signal: AbortSignal; onProgress: (e: RunEvent) => void },
  ): Promise<ExecutedRun> {
    this.emit = opts.onProgress;
    return new Promise<ExecutedRun>((resolve, reject) => {
      this.settle = { resolve, reject };
      opts.signal.addEventListener("abort", () => reject(new CancelledError()));
    }).then(async (r) => {
      await writeRun(r.run);
      return r;
    });
  }

  finish(run: ReviewRun): void {
    this.settle?.resolve({ run, reviewed: true });
  }

  fail(message: string): void {
    this.settle?.reject(new Error(message));
  }
}

export function fakeContext(driver: FakeDriver): ServerContext {
  return {
    version: "test",
    defaultRepo: "/repo",
    dataDir: "",
    webDir: null,
    gh: { available: false, authed: false },
    opencode: { path: null, version: null },
    runs: new RunManager(bindDriver(driver)),
  };
}
