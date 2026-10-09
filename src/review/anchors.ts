import type { FileDiffMetadata, Hunk } from "@pierre/diffs";
import type { DiffAnchor, DiffSide, ReviewRun } from "../types/review-run.ts";

/** A cited line this far or closer to a hunk snaps to the nearest visible line. */
export const SNAP_LIMIT = 20;

/** "12 line, 1 nearby, 2 file (not-in-diff)" over every finding and stop anchor in a run. */
export function describeAnchors(run: Pick<ReviewRun, "findings" | "overCapFindings" | "stops">): string {
  const anchors = [
    ...run.findings.map((f) => f.anchor),
    ...run.overCapFindings.map((f) => f.anchor),
    ...run.stops.flatMap((s) => s.locations),
  ];
  const count = (kind: DiffAnchor["kind"]) => anchors.filter((a) => a.kind === kind).length;
  const reasons = [...new Set(anchors.flatMap((a) => (a.kind === "file" && a.reason ? [a.reason] : [])))];
  const file = `${count("file")} file${reasons.length ? ` (${reasons.join(", ")})` : ""}`;
  return `${count("line")} line, ${count("nearby")} nearby, ${file}`;
}

export interface VisibleRange {
  start: number;
  end: number;
  hunk: Hunk;
}

/** The line spans each hunk shows on one side, in file order. */
export function visibleRanges(file: FileDiffMetadata, side: DiffSide): VisibleRange[] {
  const out: VisibleRange[] = [];
  for (const hunk of file.hunks) {
    const start = side === "additions" ? hunk.additionStart : hunk.deletionStart;
    const count = side === "additions" ? hunk.additionCount : hunk.deletionCount;
    if (count > 0) out.push({ start, end: start + count - 1, hunk });
  }
  return out;
}

/** The patch text of a visible line, without its line ending. */
export function lineText(
  file: FileDiffMetadata,
  side: DiffSide,
  range: VisibleRange,
  line: number,
): string | undefined {
  const lines = side === "additions" ? file.additionLines : file.deletionLines;
  const base = side === "additions" ? range.hunk.additionLineIndex : range.hunk.deletionLineIndex;
  return lines[base + (line - range.start)]?.replace(/\r?\n$/, "");
}

export interface AnchorOptions {
  /**
   * Try the deletions side when the line misses the additions side, before
   * snapping to a nearby line. For walkthrough stops, which may cite removed code.
   */
  deletionsFallback?: boolean;
}

function fileAnchor(path: string, cited: DiffAnchor["cited"], reason: DiffAnchor["reason"]): DiffAnchor {
  return {
    file: path,
    side: "additions",
    kind: "file",
    line: 0,
    cited,
    ...(reason ? { reason } : {}),
  };
}

function exactHit(
  file: FileDiffMetadata,
  path: string,
  side: DiffSide,
  first: number,
  last: number | undefined,
  cited: DiffAnchor["cited"],
): DiffAnchor | null {
  const range = visibleRanges(file, side).find((r) => first >= r.start && first <= r.end);
  if (!range) return null;
  const end = last !== undefined && last > first ? Math.min(last, range.end) : undefined;
  const text = lineText(file, side, range, first);
  return {
    file: path,
    side,
    kind: "line",
    line: first,
    ...(end !== undefined && end > first ? { endLine: end } : {}),
    cited,
    ...(text !== undefined ? { text } : {}),
  };
}

/**
 * Places a cited location on the diff.
 *
 * `file` is the parsed patch entry for `path`, or undefined when the patch does
 * not touch it. Lines are head-side unless the deletions fallback hits.
 */
export function anchor(
  file: FileDiffMetadata | undefined,
  path: string,
  line?: number,
  endLine?: number,
  opts: AnchorOptions = {},
): DiffAnchor {
  const hasLine = line !== undefined && Number.isFinite(line) && line > 0;
  const first = hasLine ? (endLine !== undefined && endLine > 0 ? Math.min(line, endLine) : line) : 0;
  const last = hasLine && endLine !== undefined && endLine > 0 ? Math.max(line, endLine) : undefined;
  const cited: DiffAnchor["cited"] = {
    line: first,
    ...(last !== undefined && last !== first ? { endLine: last } : {}),
  };

  if (!file) return fileAnchor(path, cited, "not-in-diff");
  if (!hasLine) return fileAnchor(path, cited, "no-line");

  if (file.type === "deleted") {
    const hit = opts.deletionsFallback ? exactHit(file, path, "deletions", first, last, cited) : null;
    return hit ?? fileAnchor(path, cited, "deleted-file");
  }

  const ranges = visibleRanges(file, "additions");
  if (!ranges.length) return fileAnchor(path, cited, "no-hunks");

  const hit =
    exactHit(file, path, "additions", first, last, cited) ??
    (opts.deletionsFallback ? exactHit(file, path, "deletions", first, last, cited) : null);
  if (hit) return hit;

  let best: { line: number; range: VisibleRange; distance: number } | undefined;
  for (const r of ranges) {
    const nearest = first < r.start ? r.start : r.end;
    const distance = Math.abs(nearest - first);
    if (!best || distance < best.distance) best = { line: nearest, range: r, distance };
  }
  if (best && best.distance <= SNAP_LIMIT) {
    const text = lineText(file, "additions", best.range, best.line);
    return {
      file: path,
      side: "additions",
      kind: "nearby",
      line: best.line,
      cited,
      ...(text !== undefined ? { text } : {}),
    };
  }
  return fileAnchor(path, cited, "far-from-diff");
}
