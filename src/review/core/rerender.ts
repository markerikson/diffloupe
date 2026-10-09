/**
 * Rebuilds the markdown and payload artifacts for stored runs.
 *
 * Formatting and ordering changes are cheap to judge and expensive to test: a
 * fresh review costs several dollars and several minutes, while every past run
 * already has its findings on disk. This replays the render half of the
 * pipeline over those records.
 *
 *   npx tsx scripts/code-review/rerender.ts            # every stored run
 *   npx tsx scripts/code-review/rerender.ts impact-13190 fast-13014
 */
import fs from "node:fs/promises";
import path from "node:path";

import { writeArtifacts, type Finding, type PriorComment, type Walkthrough } from "./pipeline.ts";
import { repoSlug } from "./lib/target.ts";
import { readJson } from "./lib/io.ts";

interface RunRecord {
  /** Absent when the run reviewed a bare commit range. */
  pr?: string;
  base: string;
  head: string;
  tag: string;
  verifiedFindings?: Finding[];
  rejected?: { title: string; reason: string }[];
  intentAlignment?: { summary?: string; unstated?: string[]; missing?: string[] };
  stats?: Record<string, unknown>;
  walkthrough?: Walkthrough;
  prior?: PriorComment[];
  resolved?: { id: number; note?: string }[];
  /** Which review of this pull request the record came from, counting from 1. */
  runs?: number;
  overCapFindings?: Finding[];
  checked?: string[];
  unreviewed?: { overCap: string[]; failed: string[]; budget?: string[] };
}

async function main() {
  const repo = process.env.REPO ?? process.cwd();
  const artifacts = process.env.CODE_REVIEW_ARTIFACTS ?? path.join(repo, ".code-review");
  const runsDir = path.join(artifacts, "runs");
  const reviewsDir = path.join(artifacts, "reviews");
  const slug = process.env.GH_REPO ?? (await repoSlug(repo));

  const want = process.argv.slice(2);
  const files = (await fs.readdir(runsDir))
    .filter((f) => f.endsWith(".json"))
    .filter((f) => want.length === 0 || want.includes(f.replace(/\.json$/, "")));

  if (files.length === 0) {
    console.log(`no run records matched in ${runsDir}`);
    return;
  }

  for (const file of files.sort()) {
    const tag = file.replace(/\.json$/, "");
    const r = await readJson<RunRecord>(path.join(runsDir, file));
    const findings = r.verifiedFindings ?? [];
    if (findings.length === 0) {
      console.log(`${tag}: no verified findings, skipped`);
      continue;
    }
    const { ordered } = await writeArtifacts({
      dir: reviewsDir,
      tag,
      slug,
      pr: r.pr === undefined ? undefined : String(r.pr),
      base: r.base,
      head: r.head,
      findings,
      intentAlignment: r.intentAlignment,
      dropped: r.rejected,
      stats: r.stats ?? {},
      walkthrough: r.walkthrough,
      prior: r.prior,
      resolved: r.resolved,
      runs: r.runs,
      overCap: r.overCapFindings,
      checked: r.checked,
      unreviewed: r.unreviewed,
      // Worktrees share an object store with the repo they were made from, so
      // this checkout can read the diff of any PR a stored run covers.
      repoDir: repo,
    });
    console.log(
      `${tag}: ${r.pr ? `PR #${r.pr}` : `${r.base.slice(0, 7)}..${r.head.slice(0, 7)}`}, ` +
        `${findings.length} findings, ${ordered.length} inline`,
    );
  }
  console.log(`\nwrote ${reviewsDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
