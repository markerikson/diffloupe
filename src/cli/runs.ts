import { Command } from "commander";
import pc from "picocolors";
import { deleteRun, listRuns, loadRun } from "../review/run-store.js";
import type { DiffAnchor, ReviewRun, ReviewTarget, RunFinding, RunHeader } from "../types/review-run.js";

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
        `  ${r.status.padEnd(8)} ${r.createdAt}  ${formatTarget(r.target)}`,
        `  ${r.repo.slug ?? r.repo.root}  ${counts(r.findingCounts)}  $${r.costUsd.toFixed(2)}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function findingLine(f: RunFinding): string {
  return `      [${f.severity}] ${f.title}\n        ${formatAnchor(f.anchor)}`;
}

export function formatRun(run: ReviewRun): string {
  const out: string[] = [];
  out.push(`${run.id}  ${run.status}`);
  out.push(`${formatTarget(run.target)}  ${run.base.slice(0, 12)}..${run.head.slice(0, 12)}`);
  out.push(`${run.repo.slug ?? run.repo.root}  ${run.createdAt}`);
  if (run.error) out.push(`error: ${run.error}`);
  if (run.priorRunId) out.push(`prior run: ${run.priorRunId}`);
  if (run.overview.focus) out.push(`focus: ${run.overview.focus}`);
  if (run.intent.alignment) out.push(`intent: ${run.intent.alignment}`);

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

  const outside = run.findings.filter((f) => !filesByPath.has(f.file));
  if (outside.length) {
    out.push("", `Findings on files outside the diff (${outside.length})`);
    for (const f of outside) out.push(findingLine(f));
  }
  if (run.overCapFindings.length) {
    out.push("", `Over the posting cap (${run.overCapFindings.length})`);
    for (const f of run.overCapFindings) out.push(findingLine(f));
  }
  if (run.stops.length) {
    out.push("", `Walkthrough stops (${run.stops.length})`);
    for (const s of run.stops) {
      out.push(`  ${s.id} ${s.title}${s.importance === "normal" ? "" : ` [${s.importance}]`}`);
      for (const l of s.locations) out.push(`      ${formatAnchor(l)}`);
    }
  }
  if (run.untrackedSkipped.length) out.push("", `Untracked files skipped: ${run.untrackedSkipped.join(", ")}`);
  if (run.unreviewed.failed.length) out.push("", `Failed slices: ${run.unreviewed.failed.join(", ")}`);
  out.push(
    "",
    `${run.findings.length} findings, ${run.files.length} files, $${run.meta.costUsd.toFixed(2)}, ${Math.round(run.meta.wallMs / 1000)}s`,
  );
  return out.join("\n");
}

async function loadOrExit(id: string): Promise<ReviewRun> {
  try {
    return await loadRun(id);
  } catch (error) {
    console.error(pc.red(`No run.json for ${id}: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

export function createRunsCommand(): Command {
  const runs = new Command("runs")
    .description("List saved review runs")
    .option("--json", "Print run headers as JSON", false)
    .action(async (options: { json: boolean }) => {
      const headers = await listRuns();
      console.log(options.json ? JSON.stringify(headers, null, 2) : formatRunList(headers));
    });

  runs
    .command("show")
    .description("Show a saved run: groups, files, findings and anchors")
    .argument("<id>", "Run id")
    .option("--json", "Print run.json", false)
    .action(async (id: string, options: { json: boolean }) => {
      const run = await loadOrExit(id);
      console.log(options.json ? JSON.stringify(run, null, 2) : formatRun(run));
    });

  runs
    .command("rm")
    .description("Delete a saved run, its artifacts and its pinned ref")
    .argument("<id>", "Run id")
    .action(async (id: string) => {
      const removed = await deleteRun(id);
      if (removed.length === 0) {
        console.error(pc.yellow(`Nothing found for ${id}`));
        process.exit(1);
      }
      for (const p of removed) console.log(`removed ${p}`);
    });

  return runs;
}
