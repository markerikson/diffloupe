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

/** A usage this close to the cited line wins over a definition further away. */
const USAGE_NEAR = 3;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The identifier a location names: its `symbol`, or a label that is itself one
 * identifier (`dispose`, `Session.dispose`). The last dotted segment is what
 * appears on a definition line.
 */
export function locationSymbol(symbol: string | undefined, label: string | undefined): string | undefined {
  for (const s of [symbol, label]) {
    const t = s?.trim().replace(/\(\)$/, "");
    if (t && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(t)) return t.slice(t.lastIndexOf(".") + 1);
  }
  return undefined;
}

/**
 * Moves a location to the line that holds `symbol` when the cited line does not.
 *
 * Models count lines in a unified diff badly, and are off by tens of lines on a
 * long hunk, but they name the function they mean correctly. When the anchored
 * line lacks the name, this searches the file's visible lines for it: a use
 * within a few lines of the cited one first, then the definition nearest the
 * cited line, then the nearest use. Additions are searched before deletions,
 * which are searched only with `deletionsFallback` or for a deleted file.
 * `cited` keeps what the model wrote.
 */
export function snapToSymbol(
  file: FileDiffMetadata | undefined,
  a: DiffAnchor,
  symbol: string | undefined,
  opts: AnchorOptions = {},
): DiffAnchor {
  if (!file || !symbol) return a;
  const word = new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
  if (a.kind !== "file" && a.text !== undefined && word.test(a.text)) return a;

  const name = escapeRegExp(symbol);
  const definition = new RegExp(
    [
      `\\b(?:function\\*?|class|interface|type|enum|namespace|def|fn|struct|trait|const|let|var)\\s+${name}(?![\\w$])`,
      `^\\s*(?:(?:export|default|public|private|protected|static|readonly|async|override|get|set|pub)\\s+)*\\*?${name}\\s*(?:<[^>]*>)?\\s*[(=:]`,
    ].join("|"),
  );
  const sides: DiffSide[] =
    file.type === "deleted" ? ["deletions"] : opts.deletionsFallback ? ["additions", "deletions"] : ["additions"];
  const cited = a.cited.line;
  for (const side of sides) {
    const hits: { line: number; text: string; definition: boolean; distance: number }[] = [];
    for (const range of visibleRanges(file, side)) {
      for (let line = range.start; line <= range.end; line++) {
        const text = lineText(file, side, range, line);
        if (text === undefined || !word.test(text)) continue;
        hits.push({ line, text, definition: definition.test(text), distance: cited > 0 ? Math.abs(line - cited) : line });
      }
    }
    if (!hits.length) continue;
    const byDistance = (x: (typeof hits)[number], y: (typeof hits)[number]) => x.distance - y.distance;
    const near = cited > 0 ? hits.filter((h) => h.distance <= USAGE_NEAR).sort(byDistance)[0] : undefined;
    const best = near ?? hits.filter((h) => h.definition).sort(byDistance)[0] ?? hits.sort(byDistance)[0];
    if (!best) continue;
    return { file: a.file, side, kind: "line", line: best.line, cited: a.cited, text: best.text };
  }
  return a;
}
