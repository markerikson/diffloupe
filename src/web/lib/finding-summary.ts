import { SEVERITY_ORDER } from "../../review/export.ts";
import {
  inTier,
  mergeRisk,
  primaryOf,
  prodRisk,
  type Surface,
  TIER_TITLE,
  type Verdict,
} from "../../review/core/verdict.ts";
import type { FindingSeverity, ReviewRun, RunFinding } from "../../types/review-run.ts";

export interface FileFindings {
  file: string;
  findings: RunFinding[];
}

export interface FindingSummary {
  merge: Verdict;
  /** Absent on runs written before findings carried a surface. */
  prod?: Verdict;
  counts: [FindingSeverity, number][];
  title: string;
  main: FileFindings[];
  other: FileFindings[];
  /** Findings about code the change did not add or modify. Not counted in the verdicts or tallies. */
  preexisting: FileFindings[];
  /** Findings that repeat a human's existing comment. */
  echoed: RunFinding[];
}

const CONFIDENCE = ["high", "medium", "low"] as const;

export function byFile(findings: readonly RunFinding[]): FileFindings[] {
  const groups = new Map<string, RunFinding[]>();
  for (const f of findings) {
    const group = groups.get(f.file);
    if (group) group.push(f);
    else groups.set(f.file, [f]);
  }
  return [...groups].map(([file, list]) => ({ file, findings: list }));
}

/** The GitHub summary comment's findings section, as data. */
export function summarizeFindings(run: Pick<ReviewRun, "files" | "findings">): FindingSummary {
  const sorted = [...run.findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      CONFIDENCE.indexOf(a.confidence) - CONFIDENCE.indexOf(b.confidence),
  );
  const reported = sorted.filter((f) => f.repeatOf === undefined && !f.preexisting);
  const preexisting = sorted.filter((f) => f.repeatOf === undefined && f.preexisting);
  const echoed = sorted.filter((f) => f.repeatOf !== undefined);
  const counts = SEVERITY_ORDER.map((s): [FindingSeverity, number] => [
    s,
    reported.filter((f) => f.severity === s).length,
  ]).filter(([, n]) => n > 0);

  const judged = reported.flatMap((f) => (f.surface ? [{ finding: f, severity: f.severity, surface: f.surface }] : []));
  const complete = judged.length === reported.length;
  const fileSurfaces = run.files.flatMap((f) => (f.surface ? [f.surface] : []));
  const tier: Surface | null = complete
    ? primaryOf(fileSurfaces.length ? fileSurfaces : judged.map((j) => j.surface))
    : null;
  const main = tier ? judged.filter((j) => inTier(j.surface, tier)).map((j) => j.finding) : reported;
  const other = tier ? judged.filter((j) => !inTier(j.surface, tier)).map((j) => j.finding) : [];

  return {
    merge: mergeRisk(reported),
    ...(complete ? { prod: prodRisk(judged) } : {}),
    counts,
    title: tier ? TIER_TITLE[tier] : "Findings",
    main: byFile(main),
    other: byFile(other),
    preexisting: byFile(preexisting),
    echoed,
  };
}
