import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { SEVERITY_ORDER } from "../../review/export.ts";
import type { DiffAnchor, GuideStop, ReviewRun, RunFinding } from "../../types/review-run.ts";

export type AnnotationMeta =
  | { kind: "finding"; finding: RunFinding; overCap: boolean }
  | { kind: "stop"; stop: GuideStop; location: number };

export type RunAnnotation = DiffLineAnnotation<AnnotationMeta>;

export interface AnnotationOptions {
  showOverCap?: boolean;
}

type AnnotatedRun = Pick<ReviewRun, "findings" | "overCapFindings" | "stops">;

const severityRank = (f: RunFinding) => SEVERITY_ORDER.indexOf(f.severity);

function compare(a: RunAnnotation, b: RunAnnotation): number {
  if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber;
  if (a.side !== b.side) return a.side === "deletions" ? -1 : 1;
  const am = a.metadata;
  const bm = b.metadata;
  if (am.kind !== bm.kind) return am.kind === "finding" ? -1 : 1;
  if (am.kind === "finding" && bm.kind === "finding") {
    if (am.overCap !== bm.overCap) return am.overCap ? 1 : -1;
    return severityRank(am.finding) - severityRank(bm.finding);
  }
  return 0;
}

/**
 * Pierre line annotations per file path: one per finding and one per stop
 * location. File-level anchors use line 0, which Pierre draws above the first
 * hunk. On a shared line, findings come first by severity, then stops.
 */
export function fileAnnotations(run: AnnotatedRun, opts: AnnotationOptions = {}): Map<string, RunAnnotation[]> {
  const out = new Map<string, RunAnnotation[]>();
  const add = (a: DiffAnchor, metadata: AnnotationMeta) => {
    const list = out.get(a.file);
    // Pierre's DiffLineAnnotation distributes over the metadata union, so a union-typed value needs the cast.
    const entry = { side: a.side, lineNumber: a.kind === "file" ? 0 : a.line, metadata } as RunAnnotation;
    if (list) list.push(entry);
    else out.set(a.file, [entry]);
  };
  for (const finding of run.findings) add(finding.anchor, { kind: "finding", finding, overCap: false });
  if (opts.showOverCap)
    for (const finding of run.overCapFindings) add(finding.anchor, { kind: "finding", finding, overCap: true });
  for (const stop of run.stops) stop.locations.forEach((loc, location) => add(loc, { kind: "stop", stop, location }));
  for (const list of out.values()) list.sort(compare);
  return out;
}

/** The lines to highlight for an anchor, or null for a file-level anchor. */
export function anchorSelection(a: DiffAnchor): SelectedLineRange | null {
  if (a.kind === "file") return null;
  return { start: a.line, end: a.endLine ?? a.line, side: a.side };
}

function citedRange(a: DiffAnchor): string {
  const { line, endLine } = a.cited;
  return endLine !== undefined && endLine !== line ? `lines ${line}-${endLine}` : `line ${line}`;
}

/**
 * Why a card is not sitting on the line it cites, in plain words, or
 * undefined for an exact line anchor.
 */
export function anchorNote(a: DiffAnchor): string | undefined {
  if (a.kind === "line") return undefined;
  if (a.kind === "nearby") return `Cited ${citedRange(a)}, which the diff does not show. Placed at the nearest changed line.`;
  const cited = a.cited.line > 0 ? `Cited ${citedRange(a)}. ` : "";
  switch (a.reason) {
    case "not-in-diff":
      return `${cited}This file is not part of the diff.`;
    case "far-from-diff":
      return `${cited}That is too far from any changed line to place on the diff.`;
    case "deleted-file":
      return `${cited}The file was deleted.`;
    case "no-hunks":
      return `${cited}The file has no content changes to show.`;
    case "no-line":
      return "About the whole file; no line cited.";
    default:
      return cited ? cited.trim() : undefined;
  }
}

/** DOM id of a rendered annotation card. */
export function annotationElementId(meta: AnnotationMeta): string {
  return meta.kind === "finding" ? `finding-${meta.finding.id}` : `stop-${meta.stop.id}-${meta.location}`;
}
