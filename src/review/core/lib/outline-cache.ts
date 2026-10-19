/**
 * Parsed outlines keyed by git blob id.
 *
 * A blob's outline never changes, so every run in every clone shares one
 * cache, and a review of a large repository re-parses only the files the change
 * touched. Each entry is its own file; its mtime records when it was last used,
 * which is what pruning goes by.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RawOutline } from "./code-outline.ts";

/** Version of `RawOutline`'s content. Bump it when parsing in code-outline.ts changes, so cached outlines are re-parsed. */
export const OUTLINE_FORMAT = 1;
const DAY_MS = 86_400_000;
const MAX_AGE_DAYS = 30;

export class OutlineCache {
  readonly dir: string;
  hits = 0;
  misses = 0;

  constructor(root: string) {
    this.dir = path.join(root, `v${OUTLINE_FORMAT}`);
  }

  private file(blob: string, language: string): string {
    return path.join(this.dir, blob.slice(0, 2), `${blob}.${language}.json`);
  }

  get(blob: string, language: string): RawOutline | null {
    const file = this.file(blob, language);
    let value: RawOutline;
    try {
      value = JSON.parse(readFileSync(file, "utf8")) as RawOutline;
    } catch {
      this.misses++;
      return null;
    }
    this.hits++;
    try {
      if (Date.now() - statSync(file).mtimeMs > DAY_MS) {
        const now = new Date();
        utimesSync(file, now, now);
      }
    } catch {
      // A concurrent prune removed it; the value is already read.
    }
    return value;
  }

  set(blob: string, language: string, value: RawOutline): void {
    const file = this.file(blob, language);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      // Written under a temporary name and renamed, so a concurrent run never
      // reads half an entry.
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(value));
      renameSync(tmp, file);
    } catch {
      // A cache that cannot be written costs the next run a parse, nothing more.
    }
  }

  /**
   * Remove entries unused for a month, and every directory left by an older
   * outline format. Runs at most once a day.
   */
  prune(now = Date.now()): number {
    const root = path.dirname(this.dir);
    const marker = path.join(root, ".last-prune");
    try {
      if (now - statSync(marker).mtimeMs < DAY_MS) return 0;
    } catch {
      // Never pruned.
    }
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(marker, new Date(now).toISOString());
    } catch {
      return 0;
    }
    let removed = 0;
    for (const version of safeReaddir(root)) {
      const dir = path.join(root, version);
      if (version.startsWith(".")) continue;
      if (dir !== this.dir) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      for (const shard of safeReaddir(dir)) {
        const shardDir = path.join(dir, shard);
        for (const name of safeReaddir(shardDir)) {
          const file = path.join(shardDir, name);
          try {
            if (now - statSync(file).mtimeMs > MAX_AGE_DAYS * DAY_MS) {
              rmSync(file, { force: true });
              removed++;
            }
          } catch {
            // Removed by a concurrent prune.
          }
        }
      }
    }
    return removed;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Blob id of every tracked file whose working copy matches the index. A file
 * with unstaged edits is left out, because its blob id no longer names what is
 * on disk; it is parsed fresh.
 */
export function blobIds(lsFilesStage: string, modified: string): Map<string, string> {
  const dirty = new Set(modified.split("\n").map((s) => s.trim()).filter(Boolean));
  const out = new Map<string, string>();
  for (const line of lsFilesStage.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [mode, blob, stage] = line.slice(0, tab).split(" ");
    const file = line.slice(tab + 1);
    // Mode 160000 is a submodule: its id names a commit, not file content. A
    // stage other than 0 is one side of an unresolved merge conflict.
    if (!blob || mode === "160000" || stage !== "0" || dirty.has(file)) continue;
    out.set(file, blob);
  }
  return out;
}
