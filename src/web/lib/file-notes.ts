import type { DiffAnchor, FindingSeverity, GuideStop } from "../../types/review-run.ts";
import { type RunAnnotation, anchorNote } from "./annotations.ts";
import { SEVERITY_LABEL } from "./format.ts";

interface NoteBase {
  key: string;
  title: string;
  /** Short line label for the row, e.g. `L42`, or `file` for a file-level anchor. */
  line: string;
  side: DiffAnchor["side"];
  /** One-line description for screen readers. */
  label: string;
  /** Full text for the tooltip. */
  tooltip: string;
}

export type FileNote =
  | (NoteBase & { kind: "finding"; id: string; severity: FindingSeverity; overCap: boolean })
  | (NoteBase & { kind: "stop"; id: string; location: number; number: number; importance: GuideStop["importance"] });

/** The cited start line, the same one the Findings tab shows, or `file`. */
function lineLabel(a: DiffAnchor): string {
  if (a.kind === "file") return "file";
  const start = a.kind === "line" ? a.line : a.cited.line;
  return start ? `L${start}` : "file";
}

function where(a: DiffAnchor): string {
  if (a.kind === "file") return "whole file";
  const start = a.kind === "line" ? a.line : a.cited.line;
  const end = a.kind === "line" ? a.endLine : a.cited.endLine;
  const range = end !== undefined && end !== start ? `lines ${start}-${end}` : `line ${start}`;
  return a.side === "deletions" ? `old ${range}` : range;
}

/**
 * One row per finding and per walkthrough stop location on a file, in the
 * order their cards appear in the diff. `stops` is the guide order, used to
 * number stops the way the Guide tab does.
 */
export function fileNotes(annotations: readonly RunAnnotation[], stops: readonly GuideStop[]): FileNote[] {
  const numberOf = new Map(stops.map((s, i) => [s.id, i + 1]));
  return annotations.flatMap((a): FileNote[] => {
    const m = a.metadata;
    if (m.kind === "finding") {
      const f = m.finding;
      const severity = SEVERITY_LABEL[f.severity];
      const at = where(f.anchor);
      const note = anchorNote(f.anchor);
      return [{
        kind: "finding",
        key: `finding:${f.id}`,
        id: f.id,
        severity: f.severity,
        overCap: m.overCap,
        title: f.title,
        line: lineLabel(f.anchor),
        side: f.anchor.side,
        label: `${severity} finding, ${at}: ${f.title}`,
        tooltip: [`${severity}${m.overCap ? " (over the posting cap)" : ""}: ${f.title}`, at, note]
          .filter(Boolean)
          .join("\n"),
      }];
    }
    const { stop, location } = m;
    const loc = stop.locations[location];
    if (!loc) return [];
    const number = numberOf.get(stop.id) ?? 0;
    const name = `${stop.importance === "critical" ? "Critical walkthrough stop" : "Walkthrough stop"} ${number}`;
    const at = where(loc);
    const parts = stop.locations.length > 1 ? ` (location ${location + 1} of ${stop.locations.length})` : "";
    return [{
      kind: "stop",
      key: `stop:${stop.id}:${location}`,
      id: stop.id,
      location,
      number,
      importance: stop.importance,
      title: stop.title,
      line: lineLabel(loc),
      side: loc.side,
      label: `${name}${parts}, ${at}: ${stop.title}`,
      tooltip: [`${name}${parts}: ${stop.title}`, loc.label, at, anchorNote(loc)].filter(Boolean).join("\n"),
    }];
  });
}
