/**
 * Saved runs under `$XDG_DATA_HOME/diffloupe/runs/<id>/`. Used by the CLI now
 * and by the server later.
 */
import os from "node:os";
import path from "node:path";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { text } from "./core/lib/proc.ts";
import type { FindingSeverity, ReviewRun, ReviewTarget, RunHeader, RunUserState } from "../types/review-run.ts";

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

export async function loadRun(id: string): Promise<ReviewRun> {
  return JSON.parse(await readFile(path.join(runDir(id), "run.json"), "utf8")) as ReviewRun;
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

/** Every run with a readable `run.json`, newest first. */
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
      });
    } catch {
      // A directory without a finished run.json: interrupted before the end.
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
  return runs.find((r) => r.status === "complete" && r.createdAt < before && targetKey(r.repo, r.target) === key)
    ?.id;
}

/**
 * Deletes a run: its directory, every artifact named by its tag, and the ref
 * that pins a synthetic commit. Returns what was removed.
 */
export async function deleteRun(id: string): Promise<string[]> {
  const removed: string[] = [];
  const dir = runDir(id);
  let repoRoot: string | undefined;
  try {
    repoRoot = (await loadRun(id)).repo.root;
  } catch {
    // No run.json; the artifacts and directory can still go.
  }

  const art = artifactsDir();
  for (const sub of ["logs", "prompts", "raw", "reviews", "runs"]) {
    let names: string[];
    try {
      names = await readdir(path.join(art, sub));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(`${id}-`) || name.startsWith(`${id}.`)) {
        const p = path.join(art, sub, name);
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
