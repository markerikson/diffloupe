import { rm } from "node:fs/promises";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { runMarkdown } from "../review/export.js";
import { formatRun, formatRunList } from "../review/format-run.js";
import { chainStats, formatStats, statsByVersion, statsTotals } from "../review/run-stats.js";
import { deleteRun, listRuns, loadRun, loadState, orphanScratch, pruneCandidates } from "../review/run-store.js";
import type { ReviewRun, RunHeader, RunKind } from "../types/review-run.js";

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
    .description("List saved runs")
    .enablePositionalOptions()
    .option("--json", "Print run headers as JSON", false)
    .option("--kind <kind>", "Only review or diff runs", parseKind)
    .action(async (options: { json: boolean; kind?: RunKind }) => {
      const headers = ofKind(await listRuns(), options.kind);
      console.log(options.json ? JSON.stringify(headers, null, 2) : formatRunList(headers));
    });

  runs
    .command("show")
    .description("Show a saved run: groups, files, findings and anchors")
    .argument("<id>", "Run id")
    .option("--json", "Print run.json", false)
    .option("--markdown", "Print the findings as markdown, as the web UI's Copy all does", false)
    .option("--over-cap", "With --markdown, include findings over the posting cap", false)
    .action(async (id: string, options: { json: boolean; markdown: boolean; overCap: boolean }) => {
      const run = await loadOrExit(id);
      if (options.markdown) {
        process.stdout.write(runMarkdown(run, { includeOverCap: options.overCap }));
        return;
      }
      console.log(options.json ? JSON.stringify(run, null, 2) : formatRun(run));
    });

  runs
    .command("stats")
    .description("How findings fared across re-reviews of the same change: raised, fixed, dismissed, still open")
    .option("--repo <path-or-slug>", "Only runs in this repository (a path, or owner/name)")
    .option("--since <age>", "Only chains reviewed within this window, e.g. 30d, 12h, 2w")
    .option("--by-version", "Also split the counts by prompt version and repo instructions", false)
    .option("--json", "Print the stats as JSON", false)
    .action(async (options: { repo?: string; since?: string; byVersion: boolean; json: boolean }) => {
      const sinceMs = options.since === undefined ? undefined : parseAge(options.since);
      if (sinceMs === null) {
        console.error(pc.red("--since takes a number with d, h, or w"));
        process.exit(1);
      }
      const repoPath = options.repo === undefined ? undefined : path.resolve(options.repo);
      const headers = (await listRuns()).filter(
        (h) =>
          !h.invalid &&
          h.status === "complete" &&
          h.kind !== "diff" &&
          (options.repo === undefined || h.repo.root === repoPath || h.repo.slug === options.repo),
      );
      const inputs = await Promise.all(
        headers.map(async (h) => ({ run: await loadRun(h.id), state: await loadState(h.id) })),
      );
      const cutoff = sinceMs === undefined ? undefined : new Date(Date.now() - sinceMs).toISOString();
      const chains = chainStats(inputs).filter((c) => cutoff === undefined || c.lastAt >= cutoff);
      const kept = new Set(chains.flatMap((c) => c.rounds.map((r) => r.id)));
      const versions = options.byVersion ? statsByVersion(inputs.filter((i) => kept.has(i.run.id))) : undefined;
      if (options.json) {
        console.log(JSON.stringify({ chains, totals: statsTotals(chains), ...(versions ? { versions } : {}) }, null, 2));
        return;
      }
      console.log(formatStats(chains, versions));
    });

  runs
    .command("rm")
    .description("Delete a saved run, its artifacts and the git refs that pin its commits")
    .argument("<id>", "Run id")
    .action(async (id: string) => {
      const removed = await deleteRun(id);
      if (removed.length === 0) {
        console.error(pc.yellow(`Nothing found for ${id}`));
        process.exit(1);
      }
      for (const p of removed) console.log(`removed ${p}`);
    });

  runs
    .command("prune")
    .description("Delete old runs and orphaned scratch files. Lists what would go unless --yes is given")
    .option("--older-than <age>", "Only runs older than this, e.g. 30d, 12h, 2w", "30d")
    .option("--keep <n>", "Always keep this many of the newest runs", "20")
    .option("--kind <kind>", "Only review or diff runs (--keep then counts runs of that kind)", parseKind)
    .option("--yes", "Delete instead of listing", false)
    .action(async (options: { olderThan: string; keep: string; yes: boolean; kind?: RunKind }) => {
      const olderThanMs = parseAge(options.olderThan);
      const keep = Number(options.keep);
      if (olderThanMs === null || !Number.isInteger(keep) || keep < 0) {
        console.error(pc.red("--older-than takes a number with d, h, or w; --keep takes a whole number"));
        process.exit(1);
      }
      const candidates = pruneCandidates(ofKind(await listRuns(), options.kind), { olderThanMs, keep });
      const orphans = await orphanScratch();
      if (candidates.length === 0 && orphans.length === 0) {
        console.log("Nothing to prune");
        return;
      }
      if (!options.yes) {
        for (const h of candidates) console.log(`would delete run ${h.id} (${h.createdAt})`);
        if (orphans.length > 0) console.log(`would delete ${orphans.length} orphaned scratch entries`);
        console.log(pc.dim("Run again with --yes to delete."));
        return;
      }
      for (const h of candidates) {
        await deleteRun(h.id);
        console.log(`deleted run ${h.id}`);
      }
      for (const p of orphans) await rm(p, { recursive: true, force: true });
      if (orphans.length > 0) console.log(`deleted ${orphans.length} orphaned scratch entries`);
    });

  return runs;
}

function parseKind(value: string): RunKind {
  if (value !== "review" && value !== "diff") throw new InvalidArgumentError("must be review or diff");
  return value;
}

function ofKind(headers: RunHeader[], kind: RunKind | undefined): RunHeader[] {
  return kind ? headers.filter((h) => (h.kind ?? "review") === kind) : headers;
}

const AGE_UNITS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

export function parseAge(age: string): number | null {
  const m = /^(\d+)([hdw])$/.exec(age.trim());
  return m ? Number(m[1]) * AGE_UNITS[m[2]!]! : null;
}
