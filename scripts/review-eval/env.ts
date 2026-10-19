// Shared paths and the evaluation set for the review-context experiments: does extra
// context (an intent draft, inline repo maps) help slice reviewers find more real issues?
//
// Inputs are past DiffLoupe runs on this machine. Outputs go to DIFFLOUPE_EVAL_DIR
// (default <data dir>/eval). Steps, in order:
//   bun scripts/review-eval/dataset.ts     ground truth per run and slice, plus PR descriptions (gh)
//   bun scripts/review-eval/prepare.ts     head trees and outlines with resolved imports
//   bun scripts/review-eval/intent.ts      intent variants judged against PR descriptions (ANTHROPIC_API_KEY)
//   bun scripts/review-eval/eval-map.ts    offline recall of map rankings against cited and read files
//   bun scripts/review-eval/ab.ts render   write each slice prompt under every arm
//   bun scripts/review-eval/ab.ts run <slice> [samples] [arms]   paid reruns through OpenCode
//   bun scripts/review-eval/ab-judge.ts judge | report            pooled blind judging with Opus
//   bun scripts/review-eval/ab-metrics.ts  cost and tool-call metrics per arm
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { artifactsDir, dataDir, runsDir } from "../../src/review/run-store.ts";

export const EVAL_DIR = process.env.DIFFLOUPE_EVAL_DIR || path.join(dataDir(), "eval");
export const DATA = path.join(EVAL_DIR, "data");
export const TREES = path.join(EVAL_DIR, "trees");
export const AB = path.join(EVAL_DIR, "ab");
export const RUNS = runsDir();
export const ARTIFACTS = artifactsDir();

interface EvalSet {
  targets: Array<{ id: string; pr: number }>;
  slices: string[];
  repos: Record<string, string>;
}

const evalSet: EvalSet = JSON.parse(fs.readFileSync(new URL("./eval-set.json", import.meta.url), "utf8"));
export const SELECTED = evalSet.targets;
export const SLICES = evalSet.slices;

export interface Target {
  id: string;
  repo: string;
  slug: string;
  branch: string;
  pr: number;
  base: string;
  head: string;
  changed: string[];
  cited: string[];
  read: string[];
  slices: Array<{ tag: string; idx: number; calls: number; files: string[]; read: string[]; cited: string[] }>;
  prTitle: string;
  prBody: string;
}

export function loadTargets(): Target[] {
  return JSON.parse(fs.readFileSync(path.join(DATA, "targets.json"), "utf8"));
}

/** The run's checkout, or the repo's main checkout when the run used a worktree that is gone. */
export function repoFor(t: { repo: string; slug: string }): string {
  if (fs.existsSync(t.repo)) return t.repo;
  const configured = evalSet.repos[t.slug];
  if (!configured) throw new Error(`${t.repo} is gone and eval-set.json has no repo path for ${t.slug}`);
  return configured.replace(/^~(?=\/)/, os.homedir());
}

export function git(repo: string, args: string[]): string {
  return Bun.spawnSync(["git", "-C", repo, "-c", "diff.renames=true", ...args], { maxBuffer: 512 << 20 }).stdout.toString();
}
