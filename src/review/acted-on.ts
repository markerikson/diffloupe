import type { PriorActedOn, RunFinding } from "../types/review-run.ts";
import type { LineHunk } from "./prior-run.ts";

/** How far the control range sits from the finding's own lines. */
const CONTROL_OFFSET = 35;

type Range = [start: number, end: number];

function touched(hunks: LineHunk[], [start, end]: Range): boolean {
  return hunks.some((h) => {
    const hunkEnd = h.oldStart + Math.max(h.oldCount, 1) - 1;
    return h.oldStart <= end && start <= hunkEnd;
  });
}

/**
 * Whether the code changed between two heads at each prior finding's lines.
 * `lineMap` holds `git diff -U0 <prior head> <head>` hunks keyed by path, with
 * a deleted file keyed by its old path. Each finding is paired with a control:
 * the same span moved 35 lines away, so the acted rate can be read against how
 * often nearby code changes anyway. Findings anchored to the deletions side or
 * to no line are left out.
 */
export function actedOn(findings: RunFinding[], lineMap: Map<string, LineHunk[]>): PriorActedOn[] {
  return findings.flatMap((f) => {
    const { line, endLine } = f.anchor.cited;
    if (f.anchor.side !== "additions" || line < 1) return [];
    const span: Range = [line, Math.max(endLine ?? line, line)];
    const shift = line > CONTROL_OFFSET ? -CONTROL_OFFSET : CONTROL_OFFSET;
    const hunks = lineMap.get(f.file) ?? [];
    return [
      {
        id: f.id,
        acted: touched(hunks, span),
        control: touched(hunks, [span[0] + shift, span[1] + shift]),
      },
    ];
  });
}
