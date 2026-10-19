// Blind-judges pooled slice findings from all A/B arms and samples with Opus, then reports per arm.
// Usage: bun ab-judge.ts judge [tagFilter] | bun ab-judge.ts report
import fs from "node:fs";
import path from "node:path";
import { complete, parseJson } from "./llm.ts";
import { SLICES, ARMS, worktree } from "./ab.ts";
import { AB, loadTargets } from "./env.ts";

const SAMPLES = 2;
const targets = loadTargets();

type Finding = {
  file: string; line?: number; end_line?: number; severity?: string; category?: string; title: string;
  explanation?: string; evidence?: string; impact?: string; confidence?: string; cross_file_refs?: string[]; preexisting?: boolean;
};
type Issue = { members: string[]; summary: string; verdict: "real" | "plausible" | "doubtful" | "wrong"; importance: number; reason: string };
type Judged = { tag: string; labels: Record<string, { run: string; title: string; severity?: string | undefined }>; issues: Issue[]; cost: number };

function findingsOf(id: string): Finding[] {
  const f = path.join(AB, "out", `${id}.json`);
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, "utf8")).findings ?? [];
}

function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function codeWindows(subject: string, refs: Array<{ file: string; line: number }>, cap: number): string {
  const byFile = new Map<string, number[]>();
  for (const r of refs) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r.line]);
  const parts: string[] = [];
  let used = 0;
  for (const [file, lines] of byFile) {
    const p = path.join(subject, file);
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) continue;
    const text = fs.readFileSync(p, "utf8").split("\n");
    const ranges: Array<[number, number]> = [];
    for (const l of lines.sort((a, b) => a - b)) {
      const lo = Math.max(1, l - 40);
      const hi = Math.min(text.length, l + 40);
      const last = ranges.at(-1);
      if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
      else ranges.push([lo, hi]);
    }
    for (const [lo, hi] of ranges) {
      const body = text.slice(lo - 1, hi).map((s, i) => `${lo + i}: ${s}`).join("\n");
      if (used + body.length > cap) return parts.join("\n\n");
      parts.push(`### ${file} lines ${lo}-${hi}\n${body}`);
      used += body.length;
    }
  }
  return parts.join("\n\n");
}

const JUDGE = `You audit findings from automated code reviewers. Several reviewers independently reviewed the same slice of a change. Their findings are pooled, shuffled, and labelled F1, F2, ... You get the change's stated intent, the slice diff, and excerpts of the code at the head commit around every location the findings cite.

Tasks:
1. Group findings that describe the same underlying problem (same root cause, even if worded differently or anchored on a different line). Every finding belongs to exactly one group.
2. For each group, decide from the diff and code excerpts:
   - verdict: "real" (the problem exists as described and matters), "plausible" (likely real but you cannot fully confirm from what you see), "doubtful" (probably wrong, overstated, or intended behavior per the stated intent), "wrong" (contradicted by the code or the intent).
   - importance: 0 = nit or style, 1 = minor, 2 = a reviewer would want it fixed before merge, 3 = serious bug, data loss, or outage risk.
   - reason: one or two sentences citing the code.
Judge each claim on its merits. Do not reward length or confident tone.

Reply with JSON only: {"issues":[{"members":["F3","F7"],"summary":"...","verdict":"real","importance":2,"reason":"..."}]}`;

async function judge(tag: string): Promise<Judged> {
  const t = targets.find((x) => tag.startsWith(x.id));
  if (!t) throw new Error(`no target for ${tag}`);
  const pooled: Array<{ id: string; run: string; f: Finding }> = [];
  for (const arm of ARMS) for (let n = 1; n <= SAMPLES; n++) for (const f of findingsOf(`${tag}-${arm}-${n}`)) pooled.push({ id: "", run: `${arm}-${n}`, f });
  const order = shuffle(pooled, tag.length * 7919 + pooled.length);
  order.forEach((x, i) => (x.id = `F${i + 1}`));
  if (!order.length) return { tag, labels: {}, issues: [], cost: 0 };
  const base = fs.readFileSync(path.join(AB, "prompts", `${tag}-base.txt`), "utf8");
  const intentSec = base.slice(base.indexOf("## Pull request intent"), base.indexOf("A repository orientation map"));
  const diff = base.slice(base.indexOf("## Diff for this slice")).slice(0, 120_000);
  const refs: Array<{ file: string; line: number }> = [];
  for (const { f } of order) {
    if (f.file) refs.push({ file: f.file, line: f.line ?? 1 });
    for (const r of f.cross_file_refs ?? []) {
      const m = r.match(/^(.+?):(\d+)/);
      if (m) refs.push({ file: m[1]!, line: Number(m[2]) });
    }
  }
  const code = codeWindows(worktree(t), refs, 90_000);
  const intent = t.prBody ? `## Author's PR description (written after the fact)\nTitle: ${t.prTitle}\n\n${t.prBody.slice(0, 8000)}` : intentSec;
  const list = order.map(({ id, f }) => {
    const { title, file, line, end_line, severity, category, explanation, evidence, impact, cross_file_refs, preexisting } = f;
    return `### ${id}\n${JSON.stringify({ title, file, line, end_line, severity, category, preexisting, explanation, evidence, impact, cross_file_refs }, null, 1)}`;
  }).join("\n\n");
  const user = `${intent}\n\n${diff}\n\n## Code excerpts at head\n${code}\n\n## Findings\n${list}`;
  const res = await complete("claude-opus-5-5", JUDGE, user, 8000);
  const out = parseJson<{ issues: Issue[] }>(res.text);
  const labels = Object.fromEntries(order.map((x) => [x.id, { run: x.run, title: x.f.title, severity: x.f.severity }]));
  return { tag, labels, issues: out.issues, cost: res.cost };
}

const [cmd = "report", filter] = process.argv.slice(2);
const JFILE = path.join(AB, "judged.json");
const judged: Record<string, Judged> = fs.existsSync(JFILE) ? JSON.parse(fs.readFileSync(JFILE, "utf8")) : {};

if (cmd === "judge") {
  for (const tag of SLICES.filter((x) => !filter || x.includes(filter))) {
    const r = await judge(tag);
    judged[tag] = r;
    fs.writeFileSync(JFILE, JSON.stringify(judged, null, 1));
    console.log(tag, "findings", Object.keys(r.labels).length, "issues", r.issues.length, "cost", r.cost.toFixed(3));
  }
} else {
  const good = (i: Issue) => i.verdict === "real" || i.verdict === "plausible";
  const rows: Record<string, { findings: number; good: number; bad: number; weighted: number; distinctGood: number; distinctWeighted: number; samples: number }> = {};
  for (const arm of ARMS) rows[arm] = { findings: 0, good: 0, bad: 0, weighted: 0, distinctGood: 0, distinctWeighted: 0, samples: 0 };
  for (const [tag, r] of Object.entries(judged)) {
    console.log(`\n## ${tag}`);
    for (const i of r.issues) {
      const runs = i.members.map((m) => r.labels[m]?.run).filter(Boolean);
      console.log(`  [${i.verdict} ${i.importance}] ${i.summary.slice(0, 110)}\n      found by: ${[...new Set(runs)].sort().join(", ")}`);
    }
    for (const arm of ARMS) {
      const row = rows[arm]!;
      const armIssues = new Set<number>();
      for (let n = 1; n <= SAMPLES; n++) {
        const run = `${arm}-${n}`;
        row.samples++;
        r.issues.forEach((i, k) => {
          const hits = i.members.filter((m) => r.labels[m]?.run === run).length;
          if (!hits) return;
          row.findings += hits;
          if (good(i)) {
            row.good++;
            row.weighted += i.importance;
            armIssues.add(k);
          } else row.bad += hits;
        });
      }
      for (const k of armIssues) {
        row.distinctGood++;
        row.distinctWeighted += r.issues[k]!.importance;
      }
    }
  }
  console.log("\narm            findings  good-issues/sample  bad-findings  importance/sample  distinct-good(2 samples)  distinct-importance");
  for (const arm of ARMS) {
    const x = rows[arm]!;
    const per = x.samples / Math.max(1, Object.keys(judged).length);
    console.log(`${arm.padEnd(14)} ${String(x.findings).padStart(8)}  ${(x.good / per).toFixed(1).padStart(18)}  ${String(x.bad).padStart(12)}  ${(x.weighted / per).toFixed(1).padStart(17)}  ${String(x.distinctGood).padStart(24)}  ${String(x.distinctWeighted).padStart(19)}`);
  }
}
