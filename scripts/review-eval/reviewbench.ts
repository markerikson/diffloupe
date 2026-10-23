// Score DiffLoupe on ReviewBench (https://github.com/review-bench/review-bench): run headless
// reviews on the benchmark PRs, convert findings to the candidate format, check transcripts for
// lookups of the public PR, judge with the ReviewBench scorer, and report.
//
// Outputs go to <eval dir>/reviewbench. RB_DIR points at an existing ReviewBench checkout
// (with `npm ci` done); otherwise `fetch` clones one into <eval dir>/reviewbench/bench.
// DIFFLOUPE_SRC=<checkout> makes `run` review with another DiffLoupe checkout.
//   bun scripts/review-eval/reviewbench.ts fetch [--set test|full] [--pr <key>...]
//   bun scripts/review-eval/reviewbench.ts run --label <name> [--pr <key>...] [-- <diffloupe review args>]
//   bun scripts/review-eval/reviewbench.ts convert --label <name>
//   bun scripts/review-eval/reviewbench.ts scan --label <name>
//   bun scripts/review-eval/reviewbench.ts judge --label <name> [--variant posted|all] [--limit N] [--exclude-claude] [--model id]
//   bun scripts/review-eval/reviewbench.ts report --label <name>
// The judge calls Anthropic with ANTHROPIC_API_KEY through a local proxy that records token usage.
import fs from "node:fs";
import path from "node:path";
import type { RunFinding, ReviewRun } from "../../src/types/review-run.ts";
import { EVAL_DIR, git } from "./env.ts";

const ROOT = path.join(EVAL_DIR, "reviewbench");
// DIFFLOUPE_SRC runs the reviews from another checkout, to score a branch with this harness.
const WORKTREE = path.resolve(process.env.DIFFLOUPE_SRC ?? path.join(import.meta.dir, "../.."));
const REVIEW_TIMEOUT_MS = 30 * 60_000;
const CLAUDE_PRODUCERS = ["llm_review:claude-", "ccr:claude-"];
// $/M tokens: input, output, cache read, cache write.
const PRICE: Record<string, [number, number, number, number]> = {
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
};

interface BenchPr {
  repo: string;
  pr_number: number;
  base: string;
  head: string;
  title: string;
  body: string | null;
}

interface RunRecord {
  key: string;
  runId?: string;
  status: "done" | "failed" | "cancelled" | "timeout" | "error";
  exit: number | null;
  costUsd?: number;
  wallMs: number;
  args: string[];
  src?: string;
}

interface CandidateFinding {
  file: string;
  start_line: number;
  end_line: number;
  message: string;
  producer: string;
}

// --- args ------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
const passthrough = dashdash === -1 ? [] : argv.slice(dashdash + 1);
const command = own[0];

function flag(name: string): string | undefined {
  const i = own.indexOf(`--${name}`);
  return i === -1 ? undefined : own[i + 1];
}
function flags(name: string): string[] {
  return own.flatMap((a, i) => (a === `--${name}` && own[i + 1] ? [own[i + 1]!] : []));
}
function has(name: string): boolean {
  return own.includes(`--${name}`);
}
function label(): string {
  const l = flag("label");
  if (!l) throw new Error("--label is required");
  return l;
}

// --- shared ----------------------------------------------------------------------------------

function benchDir(): string {
  return process.env.RB_DIR || path.join(ROOT, "bench");
}

function prKey(p: BenchPr): string {
  const [owner, repo] = new URL(p.repo).pathname.slice(1).split("/");
  return `${owner}_${repo}_${p.pr_number}-${p.head.slice(0, 8)}`;
}

function nwo(p: BenchPr): string {
  return new URL(p.repo).pathname.slice(1).replace(/\.git$/, "");
}

function loadCorpus(set = flag("set") ?? "test"): Map<string, BenchPr> {
  const file = set === "full" ? "corpus/manifest.json" : "corpus/test/test.json";
  const prs: BenchPr[] = JSON.parse(fs.readFileSync(path.join(benchDir(), file), "utf8"));
  return new Map(prs.map((p) => [prKey(p), p]));
}

function selected(corpus: Map<string, BenchPr>): Array<[string, BenchPr]> {
  const wanted = flags("pr");
  if (!wanted.length) return [...corpus];
  return wanted.map((w) => {
    const hit = [...corpus].find(([k]) => k === w || k.startsWith(`${w}-`));
    if (!hit) throw new Error(`No corpus PR matches ${w}`);
    return hit;
  });
}

const repoDir = (key: string) => path.join(ROOT, "repos", key);
const intentFile = (key: string) => path.join(ROOT, "intent", `${key}.intent.md`);
const labelDir = () => path.join(ROOT, label());
const runsFile = () => path.join(labelDir(), "runs.json");

function readJson<T>(file: string, fallback: T): T {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): { ok: boolean; out: string } {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd ?? process.cwd(), env: { ...process.env, ...opts.env }, stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
}

function loadRuns(): Record<string, RunRecord> {
  return readJson(runsFile(), {});
}

function loadRun(rec: RunRecord): ReviewRun | undefined {
  if (!rec.runId) return undefined;
  const file = path.join(labelDir(), "data", rec.key, "diffloupe", "runs", rec.runId, "run.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
}

// --- fetch -----------------------------------------------------------------------------------

function fetchBench(): void {
  if (fs.existsSync(path.join(benchDir(), "corpus"))) return;
  if (process.env.RB_DIR) throw new Error(`RB_DIR=${process.env.RB_DIR} has no corpus/`);
  console.log(`cloning ReviewBench into ${benchDir()}`);
  const clone = sh(["git", "clone", "--depth", "1", "https://github.com/review-bench/review-bench.git", benchDir()]);
  if (!clone.ok) throw new Error(clone.out);
  const install = sh(["npm", "ci"], { cwd: benchDir() });
  if (!install.ok) throw new Error(install.out);
}

function fetchPr(key: string, p: BenchPr): void {
  const dir = repoDir(key);
  const env = { GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" };
  const g = (args: string[]) => sh(["git", "-C", dir, ...args], { env });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    g(["init", "-q"]);
    g(["remote", "add", "origin", `https://github.com/review-bench/${nwo(p).replace("/", "_")}.git`]);
    g(["remote", "add", "upstream", `https://github.com/${nwo(p)}.git`]);
  }
  const present = (sha: string) => g(["cat-file", "-e", `${sha}^{commit}`]).ok;
  if (!present(p.base) || !present(p.head)) {
    const mirror = g(["fetch", "-q", "--filter=blob:none", "origin", p.base, p.head]);
    if (!mirror.ok || !present(p.base) || !present(p.head)) {
      const up = g(["fetch", "-q", "--filter=blob:none", "upstream", p.base, `pull/${p.pr_number}/head`]);
      if (!up.ok || !present(p.base) || !present(p.head)) throw new Error(`${key}: could not fetch base/head\n${mirror.out}\n${up.out}`);
    }
  }
  const co = g(["checkout", "-q", "--force", "--detach", p.head]);
  if (!co.ok) throw new Error(`${key}: checkout failed\n${co.out}`);
  fs.mkdirSync(path.dirname(intentFile(key)), { recursive: true });
  fs.writeFileSync(intentFile(key), `# ${p.title}\n\n${(p.body ?? "").trim()}\n`);
}

function cmdFetch(): void {
  fetchBench();
  for (const [key, p] of selected(loadCorpus())) {
    process.stdout.write(`${key} ... `);
    fetchPr(key, p);
    console.log("ok");
  }
}

// --- run -------------------------------------------------------------------------------------

async function reviewOne(key: string, p: BenchPr): Promise<RunRecord> {
  const dataHome = path.join(labelDir(), "data", key);
  const logFile = path.join(labelDir(), "logs", `${key}.stderr.log`);
  fs.mkdirSync(dataHome, { recursive: true });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const args = [
    "review",
    `${p.base}...${p.head}`,
    "--headless",
    "-C",
    repoDir(key),
    "--intent-file",
    intentFile(key),
    ...passthrough,
  ];
  const start = Date.now();
  const proc = Bun.spawn(["bun", path.join(WORKTREE, "src/index.ts"), ...args], {
    cwd: repoDir(key),
    env: { ...process.env, XDG_DATA_HOME: dataHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
  }, REVIEW_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exit = await proc.exited;
  clearTimeout(timer);
  fs.writeFileSync(logFile, stderr);
  fs.writeFileSync(logFile.replace(/\.stderr\.log$/, ".stdout.log"), stdout);
  const saved = /Run saved(?: as (failed|cancelled))?: (\S+)/.exec(stderr);
  const rec: RunRecord = {
    key,
    status: timedOut ? "timeout" : saved ? ((saved[1] as "failed" | "cancelled" | undefined) ?? "done") : "error",
    exit,
    wallMs: Date.now() - start,
    args: passthrough,
    src: WORKTREE,
  };
  if (saved) rec.runId = path.basename(saved[2]!);
  const run = loadRun(rec);
  if (run?.meta?.costUsd !== undefined) rec.costUsd = run.meta.costUsd;
  return rec;
}

async function cmdRun(): Promise<void> {
  const runs = loadRuns();
  for (const [key, p] of selected(loadCorpus())) {
    if (runs[key]?.status === "done") {
      console.log(`${key}: done already (${runs[key].runId})`);
      continue;
    }
    if (!fs.existsSync(intentFile(key))) fetchPr(key, p);
    console.log(`${key}: reviewing`);
    const rec = await reviewOne(key, p);
    runs[key] = rec;
    writeJson(runsFile(), runs);
    console.log(`${key}: ${rec.status} ${rec.runId ?? ""} $${rec.costUsd?.toFixed(2) ?? "?"} ${(rec.wallMs / 60_000).toFixed(1)} min`);
  }
}

// --- convert ---------------------------------------------------------------------------------

interface Hunk {
  a: number;
  b: number;
  c: number;
  d: number;
}

/** Old-side line numbers mapped onto the head file, per head path, from `git diff -U0`. */
function oldToNewMappers(repo: string, base: string, head: string): Map<string, (line: number) => number> {
  const out = git(repo, ["diff", "-U0", "--no-color", `${base}...${head}`]);
  const hunks = new Map<string, Hunk[]>();
  let file: string | undefined;
  for (const l of out.split("\n")) {
    if (l.startsWith("+++ ")) {
      file = l === "+++ /dev/null" ? undefined : l.slice(6);
      if (file) hunks.set(file, []);
      continue;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m && file)
      hunks.get(file)!.push({ a: +m[1]!, b: m[2] === undefined ? 1 : +m[2], c: +m[3]!, d: m[4] === undefined ? 1 : +m[4] });
  }
  const mappers = new Map<string, (line: number) => number>();
  for (const [f, hs] of hunks) {
    mappers.set(f, (line) => {
      let delta = 0;
      for (const h of hs) {
        if (h.b === 0) {
          if (line <= h.a) break;
        } else if (line < h.a) break;
        else if (line < h.a + h.b) return Math.max(h.c, 1);
        delta += h.d - h.b;
      }
      return Math.max(line + delta, 1);
    });
  }
  return mappers;
}

function toCandidate(f: RunFinding, producer: string, mappers: Map<string, (line: number) => number>): CandidateFinding {
  const a = f.anchor;
  let start: number;
  let end: number;
  if (a.kind === "file") {
    start = a.cited?.line || 1;
    end = a.cited?.endLine ?? start;
  } else if (a.side === "deletions") {
    const map = mappers.get(a.file) ?? ((l: number) => l);
    start = map(a.line);
    end = Math.max(start, map(a.endLine ?? a.line));
  } else {
    start = a.line;
    end = a.endLine ?? a.line;
  }
  const message = [f.title, f.explanation, f.impact].filter(Boolean).join("\n\n");
  return { file: a.file, start_line: Math.max(start, 1), end_line: Math.max(end, start, 1), message, producer };
}

type SiteRef = { file: string; line?: number };

/**
 * One candidate per extra location of a finding (`alsoAt`, from DiffLoupe builds that report
 * repeated defects once). Lines are head-side, as the reviewer wrote them.
 */
function siteCandidates(f: RunFinding & { alsoAt?: SiteRef[] }, producer: string): CandidateFinding[] {
  const message = [f.title, f.explanation, f.impact].filter(Boolean).join("\n\n");
  return (f.alsoAt ?? []).map((s) => ({
    file: s.file,
    start_line: Math.max(s.line ?? 1, 1),
    end_line: Math.max(s.line ?? 1, 1),
    message: `Same problem as the finding at ${f.file}:\n\n${message}`,
    producer,
  }));
}

function candidatesFor(f: RunFinding, producer: string, mappers: Map<string, (line: number) => number>): CandidateFinding[] {
  return [toCandidate(f, producer, mappers), ...siteCandidates(f, `${producer}:also-at`)];
}

function cmdConvert(): void {
  const corpus = loadCorpus("full");
  for (const rec of Object.values(loadRuns())) {
    const run = loadRun(rec);
    const p = corpus.get(rec.key);
    if (!run || !p || rec.status !== "done") {
      console.log(`${rec.key}: skipped (${rec.status})`);
      continue;
    }
    const mappers = oldToNewMappers(repoDir(rec.key), p.base, p.head);
    const posted = run.findings.flatMap((f) => candidatesFor(f, "diffloupe", mappers));
    const overCap = (run.overCapFindings ?? []).flatMap((f) => candidatesFor(f, "diffloupe:over-cap", mappers));
    const identity = { repo: p.repo, pr_number: p.pr_number, base: p.base, head: p.head };
    const usage = { cost_usd: run.meta?.costUsd ?? rec.costUsd ?? 0, time_in_ms: run.meta?.wallMs ?? rec.wallMs };
    writeJson(path.join(labelDir(), "posted", `${rec.key}.json`), { pr: identity, agent: "diffloupe", findings: posted, usage });
    writeJson(path.join(labelDir(), "all", `${rec.key}.json`), {
      pr: identity,
      agent: "diffloupe",
      findings: [...posted, ...overCap],
      usage,
    });
    const sites = [...posted, ...overCap].filter((c) => c.producer.endsWith(":also-at")).length;
    console.log(`${rec.key}: ${posted.length} posted, ${overCap.length} over cap (${sites} from alsoAt)`);
  }
}

// --- scan ------------------------------------------------------------------------------------

// Commands that reach the network. A URL alone is not a hit: reviewers grep for "github.com"
// in the checkout, which reads nothing about the PR.
const SHELL_LEAKS = [
  /\bcurl\b/,
  /\bwget\b/,
  /(^|[\s;&|("'`])gh\s+(pr|api|issue|repo|run|search|browse|release)\b/,
  /\bgit\s+(fetch|pull|clone|ls-remote)\b/,
  /\b(urllib|requests\.(get|post)|http\.get|fetch\(|Invoke-WebRequest)/,
];

interface ScanHit {
  file: string;
  tool: string;
  input: string;
}

function scanTranscripts(dataHome: string): ScanHit[] {
  const hits: ScanHit[] = [];
  const raw = path.join(dataHome, "diffloupe", "artifacts", "raw");
  if (!fs.existsSync(raw)) return hits;
  for (const name of fs.readdirSync(raw)) {
    if (!name.endsWith(".ndjson")) continue;
    for (const line of fs.readFileSync(path.join(raw, name), "utf8").split("\n")) {
      if (!line.includes('"tool_use"')) continue;
      let ev: { type?: string; part?: { tool?: string; state?: { input?: unknown } } };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const tool = ev.part?.tool ?? "";
      const input = JSON.stringify(ev.part?.state?.input ?? {});
      const web = /webfetch|websearch|fetch_url|browser/i.test(tool);
      const shell = /bash|shell|exec/i.test(tool) && SHELL_LEAKS.some((re) => re.test(input));
      if (web || shell) hits.push({ file: name, tool, input: input.slice(0, 300) });
    }
  }
  return hits;
}

function cmdScan(): Record<string, ScanHit[]> {
  const result: Record<string, ScanHit[]> = {};
  for (const rec of Object.values(loadRuns())) {
    result[rec.key] = scanTranscripts(path.join(labelDir(), "data", rec.key));
    console.log(`${rec.key}: ${result[rec.key]!.length ? `EXCLUDE (${result[rec.key]!.length} hits)` : "clean"}`);
  }
  writeJson(path.join(labelDir(), "scan.json"), result);
  return result;
}

// --- judge -----------------------------------------------------------------------------------

interface Usage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function costOf(u: Omit<Usage, "cost">): number {
  const [i, o, r, w] = PRICE[u.model.replace(/-\d{8}$/, "")] ?? PRICE["claude-sonnet-5"]!;
  return (u.input * i + u.output * o + u.cacheRead * r + u.cacheWrite * w) / 1e6;
}

/** Forwards to api.anthropic.com and appends each response's token usage to `log`. */
function usageProxy(log: string): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? undefined : await req.arrayBuffer();
      let model = "unknown";
      try {
        model = JSON.parse(new TextDecoder().decode(body)).model ?? model;
      } catch {}
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("accept-encoding");
      const upstream = await fetch(`https://api.anthropic.com${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        ...(body ? { body } : {}),
      });
      const out = new Headers(upstream.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      if (!upstream.body) return new Response(null, { status: upstream.status, headers: out });
      const [mine, theirs] = upstream.body.tee();
      void new Response(mine).text().then((text) => {
        const u = { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const take = (x: Record<string, number> | undefined) => {
          if (!x) return;
          u.input = x.input_tokens ?? u.input;
          u.output = x.output_tokens ?? u.output;
          u.cacheRead = x.cache_read_input_tokens ?? u.cacheRead;
          u.cacheWrite = x.cache_creation_input_tokens ?? u.cacheWrite;
        };
        if (text.trimStart().startsWith("{")) {
          try {
            take(JSON.parse(text).usage);
          } catch {}
        } else {
          for (const line of text.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === "message_start") take(ev.message?.usage);
              if (ev.type === "message_delta") take(ev.usage);
            } catch {}
          }
        }
        if (u.input + u.output + u.cacheRead + u.cacheWrite === 0) {
          fs.appendFileSync(`${log}.errors`, `${JSON.stringify({ path: url.pathname, status: upstream.status, body: text.slice(0, 500) })}\n`);
          return;
        }
        fs.appendFileSync(log, `${JSON.stringify({ ...u, cost: costOf(u), status: upstream.status })}\n`);
      });
      return new Response(theirs, { status: upstream.status, headers: out });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function judgeDirName(variant: string, excludeClaude: boolean): string {
  return `judge-${variant}${excludeClaude ? "-noclaude" : ""}`;
}

function sumUsage(file: string): { calls: number; cost: number; input: number; output: number } {
  const rows: Usage[] = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return {
    calls: rows.length,
    cost: rows.reduce((s, r) => s + r.cost, 0),
    input: rows.reduce((s, r) => s + r.input + r.cacheRead + r.cacheWrite, 0),
    output: rows.reduce((s, r) => s + r.output, 0),
  };
}

async function cmdJudge(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const variant = flag("variant") ?? "posted";
  const excludeClaude = has("exclude-claude");
  const model = flag("model") ?? "claude-sonnet-5";
  const scanFile = path.join(labelDir(), "scan.json");
  if (!fs.existsSync(scanFile)) throw new Error("run `scan` first");
  const scan: Record<string, ScanHit[]> = readJson(scanFile, {});
  const out = path.join(labelDir(), judgeDirName(variant, excludeClaude));
  const candidates = path.join(out, "candidates");
  fs.rmSync(candidates, { recursive: true, force: true });
  fs.mkdirSync(candidates, { recursive: true });
  const source = path.join(labelDir(), variant);
  for (const name of fs.readdirSync(source).sort()) {
    const key = name.replace(/\.json$/, "");
    if (scan[key]?.length) {
      console.log(`${key}: excluded by leakage scan`);
      continue;
    }
    fs.copyFileSync(path.join(source, name), path.join(candidates, name));
  }

  const piDir = path.join(out, "pi-agent");
  const usageLog = path.join(out, "usage.jsonl");
  const proxy = usageProxy(usageLog);
  writeJson(path.join(piDir, "models.json"), {
    providers: {
      anthropic: {
        baseUrl: proxy.url,
        apiKey: "ANTHROPIC_API_KEY",
        // Without forceAdaptiveThinking pi sends `thinking.type: enabled`, which Claude 5 models reject.
        models: [
          {
            id: model,
            reasoning: true,
            contextWindow: 1_000_000,
            maxTokens: 64_000,
            compat: { forceAdaptiveThinking: true },
          },
        ],
      },
    },
  });
  const limit = flag("limit");
  const args = [
    "tsx",
    "scripts/eval/eval.ts",
    "--candidate",
    candidates,
    "--golden",
    path.join(benchDir(), "golden"),
    "--manifest",
    path.join(benchDir(), "corpus/manifest.json"),
    "--output",
    path.join(out, "results.json"),
    "--repo-dir",
    path.join(ROOT, "judge-repos"),
    "--provider",
    "anthropic",
    "--model",
    model,
    "--concurrency",
    flag("concurrency") ?? "2",
    ...(limit ? ["--limit", limit] : []),
    ...(excludeClaude ? CLAUDE_PRODUCERS.flatMap((p) => ["--exclude-producer", p]) : []),
  ];
  const before = sumUsage(usageLog);
  const proc = Bun.spawn(["npx", ...args], {
    cwd: benchDir(),
    env: { ...process.env, PI_CODING_AGENT_DIR: piDir },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exit = await proc.exited;
  await Bun.sleep(500);
  proxy.stop();
  const after = sumUsage(usageLog);
  console.log(
    `judge exit ${exit}: ${after.calls - before.calls} calls, $${(after.cost - before.cost).toFixed(2)} this run, $${after.cost.toFixed(2)} total in ${usageLog}`,
  );
  if (exit !== 0) process.exit(exit);
}

// --- report ----------------------------------------------------------------------------------

interface MetricSet {
  grounded_precision: number;
  grounded_recall: number;
  augmented_precision: number;
  augmented_recall: number;
  candidate_count: number;
  golden_tp_count: number;
  golden_covered_count: number;
  matched_count: number;
  matched_tp_count: number;
  unmatched_tp_count: number;
}
interface Stratified {
  overall: MetricSet;
  by_severity: Partial<Record<"high" | "medium" | "low", MetricSet>>;
}
interface Results {
  micro: Stratified;
  per_pr: Array<{ pr_key: string; metrics: Stratified }>;
}

const JS_EXT = /\.(m|c)?(t|j)sx?$/;

function isJsPr(key: string, p: BenchPr): boolean {
  const files = git(repoDir(key), ["diff", "--name-only", `${p.base}...${p.head}`]).split("\n").filter(Boolean);
  return files.filter((f) => JS_EXT.test(f)).length * 2 > files.length;
}

function pooled(rows: Stratified[]) {
  const sum = (pick: (m: Stratified) => MetricSet | undefined, field: keyof MetricSet) =>
    rows.reduce((s, r) => s + (pick(r)?.[field] ?? 0), 0);
  const all = (f: keyof MetricSet) => sum((m) => m.overall, f);
  const hm = (f: keyof MetricSet) => sum((m) => m.by_severity.high, f) + sum((m) => m.by_severity.medium, f);
  const ratio = (a: number, b: number) => (b ? a / b : NaN);
  return {
    prs: rows.length,
    candidates: all("candidate_count"),
    groundedP: ratio(all("matched_tp_count"), all("matched_count")),
    groundedR: ratio(all("golden_covered_count"), all("golden_tp_count")),
    augmentedP: ratio(all("matched_tp_count") + all("unmatched_tp_count"), all("candidate_count")),
    hmRecall: ratio(hm("golden_covered_count"), hm("golden_tp_count")),
    hmGolden: hm("golden_tp_count"),
  };
}

function cmdReport(): void {
  const corpus = loadCorpus("full");
  const runs = Object.values(loadRuns());
  const done = runs.filter((r) => r.status === "done");
  const cost = done.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const wall = done.reduce((s, r) => s + r.wallMs, 0);
  const pct = (x: number) => (Number.isNaN(x) ? "  -  " : `${(x * 100).toFixed(1).padStart(5)}%`);
  console.log(`label ${label()}: ${done.length}/${runs.length} reviews done`);
  if (done.length)
    console.log(`review cost $${(cost / done.length).toFixed(2)}/PR, wall ${(wall / done.length / 60_000).toFixed(1)} min/PR`);
  for (const rec of done) {
    const run = loadRun(rec);
    console.log(
      `  ${rec.key}: ${run?.findings.length ?? 0} posted + ${run?.overCapFindings?.length ?? 0} over cap, $${rec.costUsd?.toFixed(2) ?? "?"}`,
    );
  }
  for (const name of fs.readdirSync(labelDir()).filter((n) => n.startsWith("judge-")).sort()) {
    const resultsFile = path.join(labelDir(), name, "results.json");
    if (!fs.existsSync(resultsFile)) continue;
    const results: Results = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
    const usage = sumUsage(path.join(labelDir(), name, "usage.jsonl"));
    const judged = results.per_pr.length;
    console.log(`\n${name}: ${judged} PRs judged, judge $${usage.cost.toFixed(2)} total ($${(usage.cost / Math.max(judged, 1)).toFixed(2)}/PR)`);
    console.log("  split       PRs  high+med R (golden)  grounded P  augmented P  candidates/PR  grounded R");
    const groups: Array<[string, Stratified[]]> = [["all", results.per_pr.map((r) => r.metrics)]];
    const js = results.per_pr.filter((r) => corpus.has(r.pr_key) && isJsPr(r.pr_key, corpus.get(r.pr_key)!));
    const other = results.per_pr.filter((r) => !js.includes(r));
    if (js.length && other.length) groups.push(["ts/js", js.map((r) => r.metrics)], ["other", other.map((r) => r.metrics)]);
    for (const [g, rows] of groups) {
      const m = pooled(rows);
      console.log(
        `  ${g.padEnd(10)} ${String(m.prs).padStart(4)}  ${`${pct(m.hmRecall)} (${m.hmGolden})`.padEnd(19)}  ${pct(m.groundedP).padStart(10)}  ${pct(m.augmentedP).padStart(11)}  ${(m.candidates / Math.max(m.prs, 1)).toFixed(1).padStart(13)}  ${pct(m.groundedR).padStart(10)}`,
      );
    }
  }
}

// --- main ------------------------------------------------------------------------------------

switch (command) {
  case "fetch":
    cmdFetch();
    break;
  case "run":
    await cmdRun();
    break;
  case "convert":
    cmdConvert();
    break;
  case "scan":
    cmdScan();
    break;
  case "judge":
    await cmdJudge();
    break;
  case "report":
    cmdReport();
    break;
  default:
    console.error("usage: reviewbench.ts fetch|run|convert|scan|judge|report (see header comment)");
    process.exit(1);
}
