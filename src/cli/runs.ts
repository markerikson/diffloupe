import { rm } from "node:fs/promises";
import { Command } from "commander";
import pc from "picocolors";
import { runMarkdown } from "../review/export.js";
import { formatRun, formatRunList } from "../review/format-run.js";
import { deleteRun, listRuns, loadRun, orphanScratch, pruneCandidates } from "../review/run-store.js";
import type { ReviewRun } from "../types/review-run.js";

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

  runs
    .command("prune")
    .description("Delete old runs and orphaned scratch files. Lists what would go unless --yes is given")
    .option("--older-than <age>", "Only runs older than this, e.g. 30d, 12h, 2w", "30d")
    .option("--keep <n>", "Always keep this many of the newest runs", "20")
    .option("--yes", "Delete instead of listing", false)
    .action(async (options: { olderThan: string; keep: string; yes: boolean }) => {
      const olderThanMs = parseAge(options.olderThan);
      const keep = Number(options.keep);
      if (olderThanMs === null || !Number.isInteger(keep) || keep < 0) {
        console.error(pc.red("--older-than takes a number with d, h, or w; --keep takes a whole number"));
        process.exit(1);
      }
      const candidates = pruneCandidates(await listRuns(), { olderThanMs, keep });
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

const AGE_UNITS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

export function parseAge(age: string): number | null {
  const m = /^(\d+)([hdw])$/.exec(age.trim());
  return m ? Number(m[1]) * AGE_UNITS[m[2]!]! : null;
}
