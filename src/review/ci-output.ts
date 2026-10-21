/**
 * The machine-readable side of `review --headless` for CI: `result.json`, the
 * `--out` copy of a run's files, and the `--fail-on` severity gate.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FindingSeverity, ReviewRun } from "../types/review-run.ts";
import { VERSION } from "../version.ts";
import { artifactName, FINDINGS_FILE } from "./core/render.ts";
import { SEVERITY_ORDER } from "./export.ts";
import { artifactsDir, runDir } from "./run-store.ts";

export type ResultStatus = "complete" | "failed" | "cancelled" | "skipped";
export type SkipReason = "no-code-files" | "over-size-limit";

export interface CiResult {
  id: string;
  status: ResultStatus;
  reviewed: boolean;
  skipReason: SkipReason | null;
  pr: number | null;
  base: string | null;
  head: string | null;
  runDir: string;
  outDir: string | null;
  payloads: string | null;
  artifactName: string | null;
  costUsd: number;
  wallMs: number;
  budgetStopped: boolean;
  skippedSlices: number;
  findings: {
    total: number;
    posted: number;
    bySeverity: Record<FindingSeverity, number>;
  };
  round: number;
  incremental: boolean;
  version: string;
}

export interface ResultExtras {
  id: string;
  status: ResultStatus;
  runDir: string;
  skipReason?: SkipReason | null;
  outDir?: string | null;
  payloads?: string | null;
  skippedSlices?: number;
  /** In GitHub mode, the round counted from the PR's summary comment instead of local runs. */
  round?: number | undefined;
}

/** Builds `result.json`. `run` is null when the run failed or was cancelled before it wrote run.json. */
export function buildResult(run: ReviewRun | null, extras: ResultExtras): CiResult {
  const bySeverity: Record<FindingSeverity, number> = { blocker: 0, "should-fix": 0, "nice-to-have": 0, question: 0 };
  for (const f of run?.findings ?? []) bySeverity[f.severity]++;
  const pr = run?.target.kind === "pr" ? run.target.number : null;
  return {
    id: extras.id,
    status: extras.status,
    reviewed: extras.status === "complete",
    skipReason: extras.skipReason ?? null,
    pr,
    base: run?.base ?? null,
    head: run?.head ?? null,
    runDir: extras.runDir,
    outDir: extras.outDir ?? null,
    payloads: extras.payloads ?? null,
    artifactName: pr !== null && run ? artifactName(pr, run.head) : null,
    costUsd: run?.meta.costUsd ?? 0,
    wallMs: run?.meta.wallMs ?? 0,
    budgetStopped: run?.meta.budgetStopped === true,
    skippedSlices: extras.skippedSlices ?? 0,
    findings: {
      total: (run?.findings.length ?? 0) + (run?.overCapFindings.length ?? 0),
      posted: run?.findings.length ?? 0,
      bySeverity,
    },
    round: extras.round ?? run?.round ?? 1,
    incremental: run?.meta.reviewScope === "incremental",
    version: VERSION,
  };
}

/** Run-dir files copied to `--out`, as [source relative to the run dir, name in `--out`]. */
const RUN_FILES: [string, string][] = [
  ["raw/review.md", "review.md"],
  ["raw/payloads.json", "payloads.json"],
  ["raw/record.json", "record.json"],
  ["raw/units.json", "units.json"],
  ["raw/byClass.json", "byClass.json"],
  [`raw/${FINDINGS_FILE}`, FINDINGS_FILE],
  ["run.json", "run.json"],
];

/**
 * Copies a run's files into `outDir`, skipping missing ones. Returns the names
 * written. `payloads: false` leaves out payloads.json, for a run that has
 * nothing to post even though the core wrote a payload file.
 */
export async function writeOutDir(
  runId: string,
  outDir: string,
  opts: { payloads?: boolean } = {},
): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const dir = runDir(runId);
  const detail = `${runId}.detail.md`;
  const files = opts.payloads === false ? RUN_FILES.filter(([, to]) => to !== "payloads.json") : RUN_FILES;
  const sources: [string, string][] = [
    ...files.map(([from, to]): [string, string] => [path.join(dir, from), to]),
    [path.join(artifactsDir(), "reviews", detail), detail],
  ];
  const copied = await Promise.all(
    sources.map(async ([from, to]) => {
      try {
        await copyFile(from, path.join(outDir, to));
        return to;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return null;
      }
    }),
  );
  return copied.filter((name) => name !== null);
}

export async function writeResult(outDir: string, result: CiResult): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
}

/** True when any posted finding is at or above `threshold`. Findings cut by the posting cap do not count. */
export function failsGate(run: Pick<ReviewRun, "findings">, threshold: FindingSeverity): boolean {
  const limit = SEVERITY_ORDER.indexOf(threshold);
  return run.findings.some((f) => SEVERITY_ORDER.indexOf(f.severity) <= limit);
}
