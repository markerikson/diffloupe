import { readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../review/core/lib/proc.ts";
import { listRuns, openCodeCallDirs } from "../review/run-store.ts";
import type { HealthResponse } from "./types.ts";
import type { RunManager } from "./run-manager.ts";

export interface ServerContext {
  version: string;
  /** Repository a run uses when the request names none. */
  defaultRepo: string | null;
  dataDir: string;
  /** Built web UI, or null to serve the status page. */
  webDir: string | null;
  gh: HealthResponse["gh"];
  opencode: HealthResponse["opencode"];
  runs: RunManager;
}

export async function probeGh(): Promise<HealthResponse["gh"]> {
  if (!Bun.which("gh")) return { available: false, authed: false, message: "gh is not installed" };
  try {
    const r = await run("gh", ["auth", "status"], { allowFail: true });
    return r.code === 0
      ? { available: true, authed: true }
      : { available: true, authed: false, message: "gh is not authenticated; run `gh auth login`" };
  } catch (err) {
    return { available: true, authed: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function probeOpenCode(): Promise<HealthResponse["opencode"]> {
  const bin = Bun.which("opencode");
  if (!bin) return { path: null, version: null };
  try {
    const r = await run(bin, ["--version"], { allowFail: true });
    return { path: bin, version: r.code === 0 ? r.stdout.trim() || null : null };
  } catch {
    return { path: bin, version: null };
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SUBJECT_PREFIX = "code-review-subject-";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes what an earlier process that was killed outright left behind:
 * review worktrees whose owning process is gone, and per-call OpenCode data
 * directories whose run is no longer running.
 */
export async function cleanupStale(defaultRepo: string | null, log: (message: string) => void): Promise<void> {
  const tmp = os.tmpdir();
  let names: string[] = [];
  try {
    names = await readdir(tmp);
  } catch {
    // No readable temp dir: nothing to clean.
  }
  for (const name of names) {
    if (!name.startsWith(SUBJECT_PREFIX)) continue;
    const pid = Number(name.slice(SUBJECT_PREFIX.length).split("-")[1]);
    if (!Number.isInteger(pid) || pid <= 0 || pidAlive(pid)) continue;
    const dir = path.join(tmp, name);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    log(`removed stale review worktree ${dir}`);
  }
  if (defaultRepo) await run("git", ["-C", defaultRepo, "worktree", "prune"], { allowFail: true }).catch(() => {});

  const running = (await listRuns()).filter((h) => h.status === "running").map((h) => h.id);
  for (const base of openCodeCallDirs()) {
    let tags: string[];
    try {
      tags = await readdir(base);
    } catch {
      continue;
    }
    for (const tag of tags) {
      const dir = path.join(base, tag);
      try {
        // A run marked running may belong to another live process; one that
        // has not touched its directory for a day was killed.
        const active =
          running.some((id) => tag.startsWith(`${id}-`)) && Date.now() - (await stat(dir)).mtimeMs < DAY_MS;
        if (!active) await rm(dir, { recursive: true, force: true });
      } catch {
        // Removed concurrently.
      }
    }
  }
}
