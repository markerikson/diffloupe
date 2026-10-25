import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFixture } from "./__fixtures__/load.ts";
import { text } from "./core/lib/proc.ts";
import {
  appendEvent,
  artifactsDir,
  createRunDir,
  deleteRun,
  findPriorRunId,
  InvalidRunError,
  listRuns,
  loadRun,
  orphanScratch,
  pruneCandidates,
  runDir,
  scratchDir,
  writeRun,
} from "./run-store.ts";
import type { RunHeader } from "../types/review-run.ts";
import { formatAnchor, formatRun, formatRunList, formatRunSummary } from "./format-run.ts";

let tmp: string;
const saved = process.env.XDG_DATA_HOME;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "diffloupe-runs-"));
  process.env.XDG_DATA_HOME = tmp;
});

afterAll(async () => {
  if (saved === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = saved;
  await rm(tmp, { recursive: true, force: true });
});

describe("run store", () => {
  test("rejects ids that leave the runs directory", () => {
    expect(() => runDir("../x")).toThrow();
    expect(() => runDir(".hidden")).toThrow();
    expect(() => runDir("")).toThrow();
  });

  test("create, append, write, list, find the prior run, delete", async () => {
    const base = loadFixture("worktree").build();
    const first = { ...base, id: "local-1", createdAt: "2026-10-08T01:00:00.000Z" };
    const second = { ...base, id: "local-2", createdAt: "2026-10-08T02:00:00.000Z" };

    for (const run of [first, second]) {
      const dir = await createRunDir(run.id);
      expect(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"))).toEqual({
        reviewedFiles: {},
        findingStatus: {},
        comments: [],
      });
      await appendEvent(run.id, { kind: "stage", stage: "slice" });
      await writeRun(run);
    }
    await createRunDir("unfinished");

    const events = (await readFile(path.join(runDir("local-1"), "events.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(events[0]!)).toMatchObject({ kind: "stage", stage: "slice" });

    expect((await loadRun("local-2")).id).toBe("local-2");
    const headers = await listRuns();
    expect(headers.map((h) => h.id)).toEqual(["local-2", "local-1"]);
    expect(headers[0]!.findingCounts).toEqual({ blocker: 0, "should-fix": 1, "nice-to-have": 1, question: 0 });

    expect(await findPriorRunId(second.repo, second.target, second.createdAt)).toBe("local-1");
    expect(await findPriorRunId(first.repo, first.target, first.createdAt)).toBeUndefined();
    expect(await findPriorRunId(first.repo, { kind: "worktree", branch: "other" }, "9999")).toBeUndefined();

    const stopped = {
      ...base,
      id: "local-3",
      createdAt: "2026-10-08T03:00:00.000Z",
      meta: { ...base.meta, roundLimit: { maxRounds: 2, round: 3 } },
    };
    await createRunDir(stopped.id);
    await writeRun(stopped);
    expect(await findPriorRunId(base.repo, base.target, "9999")).toBe("local-2");
    await deleteRun(stopped.id);

    const reviews = path.join(artifactsDir(), "reviews");
    await mkdir(reviews, { recursive: true });
    await writeFile(path.join(reviews, "local-1.md"), "x");
    await writeFile(path.join(reviews, "local-10.md"), "keep");

    const removed = await deleteRun("local-1");
    expect(removed).toContain(path.join(reviews, "local-1.md"));
    expect(removed).toContain(runDir("local-1"));
    expect(existsSync(runDir("local-1"))).toBe(false);
    expect(existsSync(path.join(reviews, "local-10.md"))).toBe(true);
    expect(await deleteRun("never-existed")).toEqual([]);
  });

  test("an invalid run.json is listed with a summary and refused by loadRun", async () => {
    const run = { ...loadFixture("worktree").build(), id: "broken-1", createdAt: "2026-10-08T03:00:00.000Z" };
    await createRunDir(run.id);
    await writeFile(
      path.join(runDir(run.id), "run.json"),
      JSON.stringify({ ...run, files: [{ path: "a.ts" }] }),
    );

    await expect(loadRun("broken-1")).rejects.toBeInstanceOf(InvalidRunError);
    const header = (await listRuns()).find((h) => h.id === "broken-1");
    expect(header?.status).toBe("complete");
    expect(header?.repo).toEqual(run.repo);
    expect(header?.invalid).toContain("files[0]");
    expect(await deleteRun("broken-1")).toContain(runDir("broken-1"));
  });

  test("deleting a run removes its scratch files and OpenCode dirs but not the shared map", async () => {
    const run = { ...loadFixture("worktree").build(), id: "scratchy-1", createdAt: "2026-10-08T04:00:00.000Z" };
    await createRunDir(run.id);
    await writeRun(run);
    const ocData = path.join(scratchDir(), "oc", "shared", "data", "scratchy-1-s00");
    const maps = path.join(artifactsDir(), "maps");
    await mkdir(ocData, { recursive: true });
    await mkdir(maps, { recursive: true });
    await writeFile(path.join(scratchDir(), "scratchy-1-merge.json"), "{}");
    await writeFile(path.join(maps, "pr-1-abc.md"), "map");

    const removed = await deleteRun("scratchy-1");
    expect(removed).toContain(path.join(scratchDir(), "scratchy-1-merge.json"));
    expect(removed).toContain(ocData);
    expect(existsSync(path.join(maps, "pr-1-abc.md"))).toBe(true);
  });

  test("deleting a run reports only the refs that existed", async () => {
    const repo = path.join(tmp, "repo");
    await mkdir(repo, { recursive: true });
    const git = (...args: string[]) => text("git", ["-C", repo, ...args]);
    await git("init", "-q");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c");
    const base = loadFixture("worktree").build();
    await Promise.all(
      ["pinned-1", "plain-1"].map(async (id) => {
        await createRunDir(id);
        await writeRun({ ...base, id, repo: { ...base.repo, root: repo } });
      }),
    );
    await git("update-ref", "refs/diffloupe/pinned-1", "HEAD");

    const pinned = await deleteRun("pinned-1");
    expect(pinned).toContain("refs/diffloupe/pinned-1");
    expect(pinned).not.toContain("refs/diffloupe/pinned-1-base");
    expect(await git("for-each-ref", "refs/diffloupe/")).toBe("");

    const plain = await deleteRun("plain-1");
    expect(plain.filter((p) => p.startsWith("refs/"))).toEqual([]);
  });

  test("orphaned scratch: files with no run directory, OpenCode dirs with no running run", async () => {
    const running = { ...loadFixture("worktree").build(), id: "live-1", status: "running" as const };
    await createRunDir(running.id);
    await writeRun(running);
    await createRunDir("owner-1");
    await writeFile(path.join(scratchDir(), "owner-1-s00.json"), "{}");
    await writeFile(path.join(scratchDir(), "gone-1-s00.json"), "{}");
    const state = path.join(scratchDir(), "oc", "shared", "state");
    for (const tag of ["gone-1-walk", "owner-1-s00", "live-1-s00"]) await mkdir(path.join(state, tag), { recursive: true });

    const orphans = await orphanScratch();
    expect(orphans).toContain(path.join(scratchDir(), "gone-1-s00.json"));
    expect(orphans).toContain(path.join(state, "gone-1-walk"));
    expect(orphans).toContain(path.join(state, "owner-1-s00"));
    expect(orphans).not.toContain(path.join(state, "live-1-s00"));
    expect(orphans).not.toContain(path.join(scratchDir(), "owner-1-s00.json"));
    expect(orphans).not.toContain(path.join(scratchDir(), "oc"));
  });
});

describe("pruneCandidates", () => {
  const day = 86_400_000;
  const now = Date.parse("2026-10-10T00:00:00.000Z");
  const base = loadFixture("worktree").build();
  const header = (id: string, daysAgo: number, status: RunHeader["status"] = "complete"): RunHeader => ({
    id,
    status,
    createdAt: new Date(now - daysAgo * day).toISOString(),
    target: base.target,
    repo: base.repo,
    findingCounts: { blocker: 0, "should-fix": 0, "nice-to-have": 0, question: 0 },
    costUsd: 0,
  });

  test("keeps the newest runs and anything younger than the cutoff", () => {
    const headers = [header("a", 1), header("b", 40), header("c", 50), header("d", 60, "running"), header("e", 5)];
    const ids = (keep: number, olderThanDays: number) =>
      pruneCandidates(headers, { keep, olderThanMs: olderThanDays * day, now }).map((h) => h.id);
    expect(ids(1, 30)).toEqual(["b", "c"]);
    expect(ids(3, 30)).toEqual(["c"]);
    expect(ids(0, 0)).toEqual(["a", "e", "b", "c"]);
    expect(ids(20, 0)).toEqual([]);
  });
});

describe("runs formatting", () => {
  test("anchors", () => {
    const cited = { line: 42 };
    expect(formatAnchor({ file: "src/app.ts", side: "additions", kind: "line", line: 42, cited })).toBe(
      "src/app.ts:42 (line)",
    );
    expect(
      formatAnchor({ file: "src/app.ts", side: "additions", kind: "nearby", line: 101, cited: { line: 120 } }),
    ).toBe("src/app.ts:120 → 101 (nearby)");
    expect(
      formatAnchor({ file: "docs/x.md", side: "additions", kind: "file", line: 0, cited, reason: "far-from-diff" }),
    ).toBe("docs/x.md (file: far-from-diff)");
    expect(formatAnchor({ file: "a.ts", side: "deletions", kind: "line", line: 3, endLine: 5, cited })).toBe(
      "a.ts:3-5 (line) [base]",
    );
  });

  test("show lists every file and finding", () => {
    const run = loadFixture("large-pr").build();
    const text = formatRun(run);
    for (const f of run.files) expect(text).toContain(f.path);
    for (const f of [...run.findings, ...run.overCapFindings]) expect(text).toContain(f.title);
    expect(formatRunList([])).toBe("No saved runs.");
  });

  test("summary leads with the most severe findings", () => {
    const run = loadFixture("large-pr").build();
    const text = formatRunSummary(run);
    const titles = run.findings.map((f) => f.title);
    for (const title of titles) expect(text).toContain(title);
    const blocker = run.findings.find((f) => f.severity === "blocker" || f.severity === "should-fix");
    const minor = run.findings.find((f) => f.severity === "nice-to-have");
    if (blocker && minor) expect(text.indexOf(blocker.title)).toBeLessThan(text.indexOf(minor.title));
  });
});
