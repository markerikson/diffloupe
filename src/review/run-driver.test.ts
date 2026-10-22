import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFixture } from "./__fixtures__/load.ts";
import { addCopyBlock, describeCoreSource, priorOptions, requestFromOptions, roundOf } from "./run-driver.ts";
import type { ReviewRun } from "../types/review-run.ts";

const base = loadFixture("small-commit").build();

function store(runs: Record<string, Partial<ReviewRun>>) {
  return async (id: string): Promise<ReviewRun> => {
    const over = runs[id];
    if (!over) throw new Error(`no run ${id}`);
    return { ...base, id, ...over };
  };
}

describe("addCopyBlock", () => {
  const summary = "### Review\n\n<details><summary>Review details</summary>\n\n</details>\n\n<!-- ai-review kind=summary pr=1 -->";

  async function runDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "diffloupe-copy-"));
    await mkdir(path.join(dir, "raw"));
    await writeFile(path.join(dir, "raw", "payloads.json"), JSON.stringify({ summary: { body: { body: summary } } }));
    await writeFile(path.join(dir, "raw", "review.md"), `# Summary comment\n\n${summary}\n`);
    return dir;
  }

  test("puts the findings into the payload and the preview", async () => {
    const dir = await runDir();
    try {
      const run = loadFixture("large-pr").build();
      await addCopyBlock(dir, run);
      const payloads = JSON.parse(await readFile(path.join(dir, "raw", "payloads.json"), "utf8"));
      expect(payloads.summary.body.body).toContain("Copy all findings as Markdown");
      expect(await readFile(path.join(dir, "raw", "review.md"), "utf8")).toContain("Copy all findings as Markdown");
      expect(await readFile(path.join(dir, "raw", "findings.md"), "utf8")).toContain(run.findings[0]!.title);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("over the comment limit, shortens findings from the end of the list", async () => {
    const dir = await runDir();
    try {
      const large = loadFixture("large-pr").build();
      const template = large.findings[0]!;
      const findings = Array.from({ length: 30 }, (_, i) => ({
        ...template,
        id: `f${i}`,
        severity: "blocker" as const,
        title: `Finding ${String(i).padStart(2, "0")}`,
        explanation: `Explanation ${i}. ${"x".repeat(5000)}`,
      }));
      await addCopyBlock(dir, { ...large, findings, overCapFindings: [] });
      const body: string = JSON.parse(await readFile(path.join(dir, "raw", "payloads.json"), "utf8")).summary.body.body;
      expect(body.length).toBeLessThanOrEqual(65536);
      expect(body).toContain("Explanation 0.");
      expect(body).not.toContain("Explanation 29.");
      expect(body).toContain("### [blocker] Finding 29");
      expect(body).toMatch(/The last \d+ findings are shortened to fit this comment/);
      expect(await readFile(path.join(dir, "raw", "findings.md"), "utf8")).toContain("Explanation 29.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("leaves the comment alone when there are no findings", async () => {
    const dir = await runDir();
    try {
      await addCopyBlock(dir, { ...base, findings: [], overCapFindings: [] });
      const payloads = JSON.parse(await readFile(path.join(dir, "raw", "payloads.json"), "utf8"));
      expect(payloads.summary.body.body).toBe(summary);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("roundOf", () => {
  test("uses the recorded round", async () => {
    expect(await roundOf({ round: 3 }, store({}))).toBe(3);
  });

  test("a run with no prior is round 1", async () => {
    expect(await roundOf({}, store({}))).toBe(1);
  });

  test("older runs count the chain back to a recorded round", async () => {
    const load = store({ b: { priorRunId: "a" }, a: { round: 2 } });
    expect(await roundOf({ priorRunId: "b" }, load)).toBe(4);
  });

  test("a missing prior ends the chain", async () => {
    expect(await roundOf({ priorRunId: "gone" }, store({}))).toBe(1);
  });

  test("a cycle in the chain stops", async () => {
    const load = store({ a: { priorRunId: "b" }, b: { priorRunId: "a" } });
    expect(await roundOf({ priorRunId: "a" }, load)).toBe(3);
  });
});

describe("requestFromOptions", () => {
  test("passes --full through only when set", async () => {
    expect((await requestFromOptions({ full: true })).full).toBe(true);
    expect("full" in (await requestFromOptions({}))).toBe(false);
  });

  test("passes --github and --head through only when set", async () => {
    const head = "a".repeat(40);
    const req = await requestFromOptions({ target: "#12", github: true, head });
    expect(req.github).toBe(true);
    expect(req.head).toBe(head);
    const plain = await requestFromOptions({ target: "#12" });
    expect("github" in plain).toBe(false);
    expect("head" in plain).toBe(false);
  });
});

describe("priorOptions", () => {
  const previous = { run: { ...base, head: "b".repeat(40) }, dismissed: [], lineMap: new Map() };

  test("a local re-review feeds the prior run in as comments", () => {
    const o = priorOptions({ github: false, full: false, previous });
    expect(o.local).toBe(true);
    expect(o.prior).toBeDefined();
    expect(o.priorHead).toBe(previous.run.head);
  });

  test("--full reviews everything again", () => {
    expect("priorHead" in priorOptions({ github: false, full: true, previous })).toBe(false);
  });

  // prepareRun never loads a prior run in GitHub mode.
  test("a GitHub review has no prior", () => {
    expect(priorOptions({ github: true, full: false })).toEqual({ local: false });
  });
});

describe("describeCoreSource", () => {
  test("an installed copy reports only the version", async () => {
    expect(await describeCoreSource("/proj/node_modules/@acemarke/diffloupe/dist", "1.2.3")).toBe("diffloupe@1.2.3");
  });

  test("a checkout adds its commit", async () => {
    expect(await describeCoreSource(import.meta.dir, "1.2.3")).toMatch(/^diffloupe@1\.2\.3\+[0-9a-f]{12}$/);
  });

  test("outside git it falls back to the version", async () => {
    expect(await describeCoreSource("/nonexistent-diffloupe-dir", "1.2.3")).toBe("diffloupe@1.2.3");
  });
});
