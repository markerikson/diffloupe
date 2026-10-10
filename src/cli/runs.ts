import { Command } from "commander";
import pc from "picocolors";
import { runMarkdown } from "../review/export.js";
import { formatRun, formatRunList } from "../review/format-run.js";
import { deleteRun, listRuns, loadRun } from "../review/run-store.js";
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

  return runs;
}
