/**
 * Saved runs under `$XDG_DATA_HOME/diffloupe/runs/<id>/`. Used by the CLI now
 * and by the server later.
 */
import os from "node:os";
import path from "node:path";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { text } from "./core/lib/proc.ts";
import { type } from "arktype";
import {
  ReviewRunSchema,
  ReviewTargetSchema,
  RunRepoSchema,
  RunStatusSchema,
  type FindingSeverity,
  type ReviewRun,
  type ReviewTarget,
  type RunHeader,
  type RunUserState,
} from "../types/review-run.ts";

export function dataDir(): string {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "diffloupe");
}

export function runsDir(): string {
  return path.join(dataDir(), "runs");
}

export function artifactsDir(): string {
  return path.join(dataDir(), "artifacts");
}

export function runDir(id: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id.startsWith(".")) throw new Error(`invalid run id: ${id}`);
  return path.join(runsDir(), id);
}

const EMPTY_STATE: RunUserState = {
  reviewedFiles: [],
  findingStatus: {},
  comments: [],
};

/** Creates `runs/<id>/` with `raw/` and an empty `state.json`. Returns the directory. */
export async function createRunDir(id: string): Promise<string> {
  const dir = runDir(id);
  await mkdir(path.join(dir, "raw"), { recursive: true });
  await writeFile(path.join(dir, "state.json"), `${JSON.stringify(EMPTY_STATE, null, 2)}\n`);
  return dir;
}

export async function appendEvent(id: string, event: unknown): Promise<void> {
  await appendFile(
    path.join(runDir(id), "events.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), ...(event as object) })}\n`,
  );
}

export async function writeRun(run: ReviewRun): Promise<void> {
  await writeFile(path.join(runDir(run.id), "run.json"), `${JSON.stringify(run, null, 2)}\n`);
}

/** A `run.json` that parsed as JSON but failed `ReviewRunSchema`. */
export class InvalidRunError extends Error {
  constructor(
    readonly id: string,
    readonly summary: string,
    readonly raw: unknown,
  ) {
    super(`run ${id} has an invalid run.json: ${summary}`);
    this.name = "InvalidRunError";
  }
}

export async function loadRun(id: string): Promise<ReviewRun> {
  const raw: unknown = JSON.parse(await readFile(path.join(runDir(id), "run.json"), "utf8"));
  const run = ReviewRunSchema(raw);
  if (run instanceof type.errors) throw new InvalidRunError(id, run.summary, raw);
  return run;
}

export async function loadState(id: string): Promise<RunUserState> {
  try {
    return JSON.parse(await readFile(path.join(runDir(id), "state.json"), "utf8")) as RunUserState;
  } catch {
    return EMPTY_STATE;
  }
}

function countBySeverity(run: ReviewRun): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = {
    blocker: 0,
    "should-fix": 0,
    "nice-to-have": 0,
    question: 0,
  };
  for (const f of run.findings ?? []) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return counts;
}

function field<T>(validate: (v: unknown) => T | type.errors, value: unknown, fallback: T): T {
  const out = validate(value);
  return out instanceof type.errors ? fallback : out;
}

/** Best-effort header for a run.json that failed validation, so the run list can still show and delete it. */
function invalidHeader(err: InvalidRunError): RunHeader {
  const raw = (typeof err.raw === "object" && err.raw !== null ? err.raw : {}) as Record<string, unknown>;
  const meta = (typeof raw.meta === "object" && raw.meta !== null ? raw.meta : {}) as Record<string, unknown>;
  return {
    id: err.id,
    status: field(RunStatusSchema, raw.status, "failed"),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    target: field(ReviewTargetSchema, raw.target, { kind: "worktree" }),
    repo: field(RunRepoSchema, raw.repo, { root: "" }),
    findingCounts: { blocker: 0, "should-fix": 0, "nice-to-have": 0, question: 0 },
    costUsd: typeof meta.costUsd === "number" ? meta.costUsd : 0,
    ...(meta.kind === "diff" ? { kind: "diff" as const } : {}),
    invalid: err.summary,
  };
}

/**
 * Every run with a readable `run.json`, newest first. Runs whose file fails
 * validation are listed with `invalid` set.
 */
export async function listRuns(): Promise<RunHeader[]> {
  let ids: string[];
  try {
    ids = await readdir(runsDir());
  } catch {
    return [];
  }
  const headers: RunHeader[] = [];
  for (const id of ids) {
    try {
      const run = await loadRun(id);
      headers.push({
        id: run.id,
        status: run.status,
        createdAt: run.createdAt,
        target: run.target,
        repo: run.repo,
        findingCounts: countBySeverity(run),
        costUsd: run.meta?.costUsd ?? 0,
        ...(run.meta?.kind ? { kind: run.meta.kind } : {}),
      });
    } catch (err) {
      // Otherwise a directory without a finished run.json: interrupted before the end.
      if (err instanceof InvalidRunError) headers.push(invalidHeader(err));
    }
  }
  return headers.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Identifies "the same thing reviewed again": a pull request by repo and
 * number, a local target by repo root, kind and branch or spec.
 */
export function targetKey(repo: { root: string; slug?: string }, target: ReviewTarget): string {
  if (target.kind === "pr") return `pr:${repo.slug ?? repo.root}#${target.number}`;
  if ("spec" in target) return `${target.kind}:${repo.root}:${target.spec}`;
  return `local:${repo.root}:${target.branch ?? ""}`;
}

export async function findPriorRunId(
  repo: { root: string; slug?: string },
  target: ReviewTarget,
  before: string,
): Promise<string | undefined> {
  const key = targetKey(repo, target);
  const runs = await listRuns();
  return runs.find(
    (r) => r.status === "complete" && r.kind !== "diff" && r.createdAt < before && targetKey(r.repo, r.target) === key,
  )?.id;
}

export function scratchDir(): string {
  return path.join(dataDir(), "scratch");
}

/** Per-call OpenCode data and state directories, named `<run id>-<stage>`. */
export function openCodeCallDirs(): string[] {
  const shared = path.join(scratchDir(), "oc", "shared");
  return [path.join(shared, "data"), path.join(shared, "state")];
}

/**
 * Directories holding files named after a run: artifacts, agent output in
 * `scratch/`, and per-call OpenCode directories. Maps are keyed by target and
 * shared across runs, so they are not listed.
 */
function runFileDirs(): string[] {
  const art = artifactsDir();
  return [
    ...["logs", "prompts", "raw", "reviews", "runs"].map((sub) => path.join(art, sub)),
    scratchDir(),
    ...openCodeCallDirs(),
  ];
}

/**
 * Deletes a run: its directory, every artifact and scratch file named by its
 * tag, and the ref that pins a synthetic commit. Returns what was removed.
 */
export async function deleteRun(id: string): Promise<string[]> {
  const removed: string[] = [];
  const dir = runDir(id);
  let repoRoot: string | undefined;
  try {
    repoRoot = (await loadRun(id)).repo.root;
  } catch (err) {
    // Without a valid run.json the artifacts and directory can still go.
    if (err instanceof InvalidRunError) repoRoot = invalidHeader(err).repo.root || undefined;
  }

  for (const base of runFileDirs()) {
    let names: string[];
    try {
      names = await readdir(base);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(`${id}-`) || name.startsWith(`${id}.`)) {
        const p = path.join(base, name);
        await rm(p, { recursive: true, force: true });
        removed.push(p);
      }
    }
  }

  if (repoRoot) {
    const ref = `refs/diffloupe/${id}`;
    try {
      await text("git", ["-C", repoRoot, "update-ref", "-d", ref]);
      removed.push(ref);
    } catch {
      // No such ref: the target was a real commit range or a pull request.
    }
  }

  try {
    await readdir(dir);
    await rm(dir, { recursive: true, force: true });
    removed.push(dir);
  } catch {
    // Already gone.
  }
  return removed;
}

export interface PruneOptions {
  /** Only runs created longer ago than this are candidates. */
  olderThanMs: number;
  /** The newest runs to keep regardless of age. */
  keep: number;
  now?: number;
}

/**
 * Runs `runs prune` would delete: past the newest `keep` and older than
 * `olderThanMs`. Running runs are never selected.
 */
export function pruneCandidates(headers: RunHeader[], opts: PruneOptions): RunHeader[] {
  const cutoff = (opts.now ?? Date.now()) - opts.olderThanMs;
  return headers
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(Math.max(0, opts.keep))
    .filter((h) => h.status !== "running" && Date.parse(h.createdAt) < cutoff);
}

/**
 * Scratch files whose run no longer has a directory under `runs/`, and
 * per-call OpenCode directories whose run is not running: left by deleted
 * runs, killed processes, or older versions.
 */
export async function orphanScratch(): Promise<string[]> {
  let ids: string[] = [];
  try {
    ids = await readdir(runsDir());
  } catch {
    // No runs: every scratch entry is an orphan.
  }
  const running = (await listRuns()).filter((h) => h.status === "running").map((h) => h.id);
  const ownedBy = (name: string, owners: string[]) =>
    owners.some((id) => name.startsWith(`${id}-`) || name.startsWith(`${id}.`));
  const orphans: string[] = [];
  const collect = async (base: string, keep: (name: string) => boolean) => {
    let names: string[];
    try {
      names = await readdir(base);
    } catch {
      return;
    }
    for (const name of names) if (!keep(name)) orphans.push(path.join(base, name));
  };
  await collect(scratchDir(), (name) => !name.endsWith(".json") || ownedBy(name, ids));
  for (const base of openCodeCallDirs()) await collect(base, (name) => ownedBy(name, running));
  return orphans;
}
