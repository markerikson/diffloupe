import { describeAnchors } from "./anchors.ts";
import {
  runKind,
  type DiffAnchor,
  type FindingSeverity,
  type ReviewRun,
  type ReviewTarget,
  type RunFinding,
  type RunHeader,
} from "../types/review-run.ts";

export function formatTarget(target: ReviewTarget): string {
  if (target.kind === "pr") return `PR #${target.number} ${target.title}`;
  if ("spec" in target) return `${target.kind} ${target.spec}`;
  return target.branch ? `${target.kind} (${target.branch})` : target.kind;
}

/** `src/app.ts:42 (line)`, `src/app.ts:120 → 101 (nearby)`, `docs/x.md (file: far-from-diff)`. */
export function formatAnchor(a: DiffAnchor): string {
  const side = a.side === "deletions" ? " [base]" : "";
  if (a.kind === "file") return `${a.file} (file${a.reason ? `: ${a.reason}` : ""})`;
  const range = (line: number, end?: number) => (end && end !== line ? `${line}-${end}` : `${line}`);
  if (a.kind === "nearby") return `${a.file}:${range(a.cited.line, a.cited.endLine)} → ${a.line} (nearby)${side}`;
  return `${a.file}:${range(a.line, a.endLine)} (line)${side}`;
}

function counts(c: RunHeader["findingCounts"]): string {
  const parts = [
    c.blocker && `${c.blocker} blocker`,
    c["should-fix"] && `${c["should-fix"]} should-fix`,
    c["nice-to-have"] && `${c["nice-to-have"]} nice-to-have`,
    c.question && `${c.question} question`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no findings";
}

export function formatRunList(runs: RunHeader[]): string {
  if (runs.length === 0) return "No saved runs.";
  return runs
    .map((r) =>
      [
        r.id,
        `  ${(r.kind ?? "review").padEnd(6)} ${r.status.padEnd(8)} ${r.createdAt}  ${formatTarget(r.target)}`,
        r.kind === "diff"
          ? `  ${r.repo.slug ?? r.repo.root}${r.costUsd ? `  $${r.costUsd.toFixed(2)}` : ""}`
          : `  ${r.repo.slug ?? r.repo.root}  ${counts(r.findingCounts)}  $${r.costUsd.toFixed(2)}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function carried(f: RunFinding): string {
  const notes = [f.preexisting && "pre-existing", f.carriedFrom && `open since ${f.carriedFrom}`].filter(Boolean);
  return notes.length ? `  (${notes.join(", ")})` : "";
}

function findingLine(f: RunFinding): string {
  return `      [${f.severity}] ${f.title}${carried(f)}\n        ${formatAnchor(f.anchor)}`;
}

function resolvedLines(run: ReviewRun, indent: string): string[] {
  if (!run.resolved.length) return [];
  return [
    "",
    `Fixed since the prior run (${run.resolved.length})`,
    ...run.resolved.map(
      (r) => `${indent}${r.title ?? r.id}${r.file ? `  ${r.file}` : ""}${r.note ? `\n${indent}  ${r.note}` : ""}`,
    ),
  ];
}

/** "Round 2: only the 3 files changed since the last review were reviewed again", or nothing for a first review. */
export function describeRound(run: Pick<ReviewRun, "round" | "meta">): string | undefined {
  if (!run.round || run.round < 2) return undefined;
  const { reviewScope, reviewedFiles, scopeReason } = run.meta;
  if (reviewScope === "incremental") {
    const n = reviewedFiles ?? 0;
    return n === 0
      ? `Round ${run.round}: no code changed since the last review`
      : `Round ${run.round}: only the ${n === 1 ? "file" : `${n} files`} changed since the last review ${n === 1 ? "was" : "were"} reviewed again`;
  }
  return `Round ${run.round}: full review${scopeReason ? ` (${scopeReason})` : ""}`;
}

export function formatRun(run: ReviewRun): string {
  const out: string[] = [];
  out.push(`${run.id}  ${run.status}`);
  out.push(`${formatTarget(run.target)}  ${run.base.slice(0, 12)}..${run.head.slice(0, 12)}`);
  out.push(`${run.repo.slug ?? run.repo.root}  ${run.createdAt}`);
  if (run.error) out.push(`error: ${run.error}`);
  if (run.priorRunId) out.push(`prior run: ${run.priorRunId}`);
  const round = describeRound(run);
  if (round) out.push(round);
  if (run.overview.focus) out.push(`focus: ${run.overview.focus}`);
  if (run.intent.alignment) out.push(`intent: ${run.intent.alignment}`);

  const filesByPath = new Map(run.files.map((f) => [f.path, f]));
  out.push(...groupLines(run));

  const outside = run.findings.filter((f) => !filesByPath.has(f.file));
  if (outside.length) {
    out.push("", `Findings on files outside the diff (${outside.length})`);
    for (const f of outside) out.push(findingLine(f));
  }
  if (run.overCapFindings.length) {
    out.push("", `Over the posting cap (${run.overCapFindings.length})`);
    for (const f of run.overCapFindings) out.push(findingLine(f));
  }
  out.push(...resolvedLines(run, "  "));
  if (run.stops.length) {
    out.push("", `Walkthrough stops (${run.stops.length})`);
    for (const s of run.stops) {
      out.push(`  ${s.id} ${s.title}${s.importance === "normal" ? "" : ` [${s.importance}]`}`);
      for (const l of s.locations) out.push(`      ${formatAnchor(l)}`);
    }
  }
  if (run.untrackedSkipped.length) out.push("", `Untracked files skipped: ${run.untrackedSkipped.join(", ")}`);
  if (run.unreviewed.failed.length) out.push("", `Failed slices: ${run.unreviewed.failed.join(", ")}`);
  if (run.unreviewed.budget?.length)
    out.push("", `Not reviewed (cost limit): ${run.unreviewed.budget.join(", ")}`);
  if (runKind(run) === "diff") {
    out.push("", `${run.files.length} files${cost(run)}, ${(run.meta.wallMs / 1000).toFixed(1)}s`);
    return out.join("\n");
  }
  out.push(
    "",
    `${run.findings.length} findings, ${run.files.length} files, $${run.meta.costUsd.toFixed(2)}, ${Math.round(run.meta.wallMs / 1000)}s`,
    `anchors: ${describeAnchors(run)}`,
  );
  return out.join("\n");
}

function cost(run: ReviewRun): string {
  return run.meta.costUsd ? `, $${run.meta.costUsd.toFixed(2)}` : "";
}

/** Each group with its files, line counts and the findings on each file. */
function groupLines(run: ReviewRun): string[] {
  const out: string[] = [];
  const byId = new Map(run.findings.map((f) => [f.id, f]));
  const filesByPath = new Map(run.files.map((f) => [f.path, f]));
  for (const g of run.groups) {
    const leaf = !run.groups.some((c) => c.parentId === g.id);
    if (!leaf || (!g.parentId && g.files.length === 0)) {
      const note = leaf && g.stopIds.length ? `  (stops ${g.stopIds.join(", ")}; files sit in other groups)` : "";
      out.push("", `${g.critical ? "! " : ""}${g.title}${note}`);
      continue;
    }
    const indent = g.parentId ? "  " : "";
    out.push(`${g.parentId ? "" : "\n"}${indent}${g.critical ? "! " : ""}${g.title}`);
    for (const p of g.files) {
      const f = filesByPath.get(p);
      const stat = f ? ` ${f.status} +${f.additions} -${f.deletions}${f.isBinary ? " binary" : ""}` : "";
      out.push(`${indent}  ${p}${stat}`);
      for (const id of g.findingIds) {
        const finding = byId.get(id);
        if (finding?.file === p) out.push(findingLine(finding));
      }
    }
  }
  return out;
}

/**
 * What `diff --headless` prints when it finishes: the target, what the change
 * does when a walkthrough ran, then every group with its files.
 */
export function formatDiffSummary(run: ReviewRun): string {
  const out: string[] = [];
  out.push(`${formatTarget(run.target)}  ${run.base.slice(0, 12)}..${run.head.slice(0, 12)}`);
  if (run.intent.inferred) out.push("", `What it does: ${lead(run.intent.inferred, 400)}`);
  out.push(...groupLines(run));
  if (run.untrackedSkipped.length) out.push("", `Untracked files skipped: ${run.untrackedSkipped.join(", ")}`);
  const adds = run.files.reduce((n, f) => n + f.additions, 0);
  const dels = run.files.reduce((n, f) => n + f.deletions, 0);
  out.push("", `${run.files.length} files, +${adds} -${dels}${cost(run)}`);
  return out.join("\n");
}

const SEVERITY_ORDER: FindingSeverity[] = ["blocker", "should-fix", "question", "nice-to-have"];

/** First sentence, cut to `max` characters. */
function lead(text: string, max = 200): string {
  const first = text.trim().split(/(?<=[.!?])\s+/)[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/**
 * What `review --headless` prints when it finishes: the verdict, each finding
 * with its location and first sentence, and where to start reading.
 */
export function formatRunSummary(run: ReviewRun): string {
  const out: string[] = [];
  out.push(`${formatTarget(run.target)}  ${run.base.slice(0, 12)}..${run.head.slice(0, 12)}`);
  if (run.unreviewed.failed.length) out.push(`Incomplete: ${run.unreviewed.failed.length} slice(s) failed.`);
  const budgetSkipped = run.unreviewed.budget ?? [];
  if (budgetSkipped.length) out.push(`Incomplete: cost limit reached, ${budgetSkipped.length} file(s) not reviewed.`);

  const { intent } = run;
  if (intent.alignment) {
    out.push("", `Intent: ${intent.alignment}`);
    for (const m of intent.mismatches ?? []) out.push(`  - ${m}`);
  } else if (intent.inferred) {
    out.push("", `What it does: ${lead(intent.inferred, 400)}`);
  }
  if (run.overview.focus) out.push("", `Focus: ${run.overview.focus}`);

  const findings = [...run.findings].sort(
    (a, b) =>
      Number(a.preexisting ?? false) - Number(b.preexisting ?? false) ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  out.push("", findings.length ? `Findings (${findings.length})` : "No findings.");
  for (const f of findings) {
    out.push(`  [${f.severity}] ${f.title}${carried(f)}`, `    ${formatAnchor(f.anchor)}`);
    const why = lead(f.impact ?? f.explanation);
    if (why && why !== f.title) out.push(`    ${why}`);
  }
  if (run.overCapFindings.length) out.push(`  …and ${run.overCapFindings.length} more over the cap (runs show)`);
  out.push(...resolvedLines(run, "  "));

  if (run.overview.startHere.length) {
    out.push("", "Start here");
    run.overview.startHere.forEach((s, i) => out.push(`  ${i + 1}. ${s.file} — ${s.why}`));
  }
  return out.join("\n");
}
