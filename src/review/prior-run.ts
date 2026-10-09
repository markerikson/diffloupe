import type { PriorComment } from "./core/context.ts";
import type { ReviewRun } from "../types/review-run.ts";

/** Finding ids carry a `-n` suffix when two findings share a fingerprint. */
export function fingerprintOf(findingId: string): string {
  return findingId.replace(/-\d+$/, "");
}

/**
 * The prior run's findings as the bot's own earlier comments. The id is the
 * finding's position plus one, which is how `resolved` ids in the new record
 * map back to findings.
 */
export function priorComments(prev: ReviewRun): PriorComment[] {
  return prev.findings.map((f, i) => ({
    id: i + 1,
    file: f.file,
    ...(f.anchor.cited.line ? { line: f.anchor.cited.line } : {}),
    author: "diffloupe",
    body: `**${f.title}** ${f.impact ?? f.explanation}`,
    resolved: false,
    mine: true,
    fingerprint: fingerprintOf(f.id),
  }));
}

export interface LineHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** Hunk headers of a `git diff -U0`, keyed by the new path. */
export function parseZeroContextDiff(diff: string): Map<string, LineHunk[]> {
  const out = new Map<string, LineHunk[]>();
  let current: LineHunk[] | undefined;
  for (const line of diff.split("\n")) {
    const file = line.match(/^\+\+\+ (?:b\/(.+)|\/dev\/null)$/);
    if (file) {
      current = file[1] ? [] : undefined;
      if (file[1] && current) out.set(file[1], current);
      continue;
    }
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h && current) {
      current.push({
        oldStart: Number(h[1]),
        oldCount: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newCount: h[4] === undefined ? 1 : Number(h[4]),
      });
    }
  }
  return out;
}

/**
 * Where a line of the old file sits in the new one. A line that was itself
 * edited maps to the start of the edit that replaced it.
 */
export function mapLine(hunks: LineHunk[], line: number): number {
  let shift = 0;
  for (const h of hunks) {
    if (h.oldCount === 0) {
      // Pure insertion after line `oldStart`.
      if (line <= h.oldStart) break;
      shift += h.newCount;
      continue;
    }
    if (line < h.oldStart) break;
    if (line < h.oldStart + h.oldCount) return Math.max(1, h.newStart);
    shift += h.newCount - h.oldCount;
  }
  return line + shift;
}
