import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFixture } from "./__fixtures__/load.ts";
import { buildResult, failsGate, writeOutDir } from "./ci-output.ts";
import { artifactsDir, runDir } from "./run-store.ts";
import type { ReviewRun, RunFinding } from "../types/review-run.ts";
import { VERSION } from "../version.ts";

const largePr = loadFixture("large-pr").build();

function withFindings(findings: Partial<RunFinding>[], overCap: Partial<RunFinding>[] = []): ReviewRun {
  const template = largePr.findings[0]!;
  return {
    ...largePr,
    findings: findings.map((f, i) => ({ ...template, id: `f${i}`, ...f })),
    overCapFindings: overCap.map((f, i) => ({ ...template, id: `o${i}`, ...f })),
  };
}

describe("buildResult", () => {
  test("a complete pull request review", () => {
    const run: ReviewRun = {
      ...withFindings([{ severity: "blocker" }, { severity: "question" }, { severity: "question" }], [{ severity: "nice-to-have" }]),
      target: { kind: "pr", number: 42 } as ReviewRun["target"],
      round: 2,
      meta: { ...largePr.meta, costUsd: 1.5, wallMs: 9000, budgetStopped: true, reviewScope: "incremental" },
    };
    const r = buildResult(run, { id: "x", status: "complete", runDir: "/runs/x", payloads: "/out/payloads.json", outDir: "/out", skippedSlices: 2 });
    expect(r).toMatchObject({
      id: "x",
      status: "complete",
      reviewed: true,
      skipReason: null,
      pr: 42,
      head: run.head,
      outDir: "/out",
      payloads: "/out/payloads.json",
      artifactName: `ai-code-review-42-${run.head.slice(0, 9)}`,
      costUsd: 1.5,
      wallMs: 9000,
      budgetStopped: true,
      skippedSlices: 2,
      findings: { total: 4, posted: 3, minor: 0, bySeverity: { blocker: 1, "should-fix": 0, "nice-to-have": 0, question: 2 } },
      round: 2,
      incremental: true,
      version: VERSION,
    });
  });

  test("findings below the posting threshold are counted as minor, not posted", () => {
    const run: ReviewRun = {
      ...withFindings([{ severity: "blocker" }, { severity: "nice-to-have" }, { severity: "question" }]),
      meta: { ...largePr.meta, postMinSeverity: "should-fix" },
    };
    const r = buildResult(run, { id: "x", status: "complete", runDir: "/runs/x" });
    expect(r.findings).toMatchObject({ total: 3, posted: 1, minor: 2 });
  });

  test("a run that failed before saving anything", () => {
    const r = buildResult(null, { id: "x", status: "failed", runDir: "/runs/x" });
    expect(r).toMatchObject({ reviewed: false, pr: null, head: null, artifactName: null, payloads: null, costUsd: 0, round: 1 });
    expect(r.findings.total).toBe(0);
  });

  test("a GitHub round replaces the local one", () => {
    const run: ReviewRun = { ...withFindings([]), round: 1 };
    expect(buildResult(run, { id: "x", status: "complete", runDir: "/runs/x", round: 3 }).round).toBe(3);
  });

  test("a skipped run is not reviewed", () => {
    const r = buildResult(withFindings([]), { id: "x", status: "skipped", skipReason: "no-code-files", runDir: "/runs/x" });
    expect(r.reviewed).toBe(false);
    expect(r.skipReason).toBe("no-code-files");
  });
});

describe("failsGate", () => {
  test("trips on a finding at or above the threshold", () => {
    const run = withFindings([{ severity: "should-fix" }]);
    expect(failsGate(run, "blocker")).toBe(false);
    expect(failsGate(run, "should-fix")).toBe(true);
    expect(failsGate(run, "question")).toBe(true);
  });

  // Over-cap findings are not posted, so a reader of the pull request never
  // sees them. Failing the job over one would be a failure with no visible cause.
  test("ignores findings over the posting cap", () => {
    expect(failsGate(withFindings([], [{ severity: "blocker" }]), "blocker")).toBe(false);
  });
});

describe("writeOutDir", () => {
  let tmp = "";
  const saved = process.env.XDG_DATA_HOME;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "diffloupe-ci-out-"));
    process.env.XDG_DATA_HOME = tmp;
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
    await rm(tmp, { recursive: true, force: true });
  });

  test("copies the run's files and skips the missing ones", async () => {
    const dir = runDir("run-1");
    await mkdir(path.join(dir, "raw"), { recursive: true });
    await writeFile(path.join(dir, "run.json"), "{}");
    await writeFile(path.join(dir, "raw", "review.md"), "# r");
    await writeFile(path.join(dir, "raw", "payloads.json"), "{}");
    await mkdir(path.join(artifactsDir(), "reviews"), { recursive: true });
    await writeFile(path.join(artifactsDir(), "reviews", "run-1.detail.md"), "detail");

    const out = path.join(tmp, "out");
    const written = await writeOutDir("run-1", out);
    expect(written.sort()).toEqual(["payloads.json", "review.md", "run-1.detail.md", "run.json"]);
    expect((await readdir(out)).sort()).toEqual(written);
  });

  test("leaves out payloads.json for a run with nothing to post", async () => {
    const out = path.join(tmp, "out-skipped");
    const written = await writeOutDir("run-1", out, { payloads: false });
    expect(written.sort()).toEqual(["review.md", "run-1.detail.md", "run.json"]);
  });
});
