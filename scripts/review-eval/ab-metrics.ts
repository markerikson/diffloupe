// Cost and tool-call metrics per arm from the A/B transcripts.
import fs from "node:fs";
import path from "node:path";
import { prepare, rank, fit } from "./rank.ts";
import { ARMS } from "./ab.ts";
import { AB, loadTargets } from "./env.ts";

const targets = loadTargets();
const results: Array<{ id: string; tag: string; arm: string; costUsd: number; findings: number | null }> = fs
  .readFileSync(path.join(AB, "results.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

function calls(file: string) {
  const out: Array<{ tool: string; path?: string | undefined; out: number }> = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    const e = JSON.parse(line);
    if (e.type !== "tool_use") continue;
    const inp = e.part?.state?.input ?? {};
    const raw = inp.path ?? inp.filePath ?? inp.target ?? (Array.isArray(inp.paths) ? inp.paths[0] : undefined);
    const p = typeof raw === "string" ? raw.replace(/^.*?\/subjects\/[0-9a-f]{12}\//, "") : undefined;
    out.push({ tool: e.part.tool, path: p, out: String(e.part?.state?.output ?? "").length });
  }
  return out;
}

const maps = new Map<string, Set<string>>();
type Agg = { n: number; cost: number; calls: number; outK: number; unchangedReads: number; inMap: number; firstInMap: number; firstTotal: number; searches: number; findings: number };
const agg: Record<string, Agg> = {};
for (const arm of ARMS) agg[arm] = { n: 0, cost: 0, calls: 0, outK: 0, unchangedReads: 0, inMap: 0, firstInMap: 0, firstTotal: 0, searches: 0, findings: 0 };
for (const r of results) {
  const t = targets.find((x) => r.tag.startsWith(x.id));
  const s = t?.slices.find((x) => `${t.id}-${x.tag}` === r.tag);
  const a = agg[r.arm];
  if (!t || !s || !a) continue;
  if (!maps.has(r.tag)) {
    const P = prepare(t);
    maps.set(r.tag, new Set(fit(P, rank(P, { seeds: s.files, damp: true, hop2: true, strings: true, stringWeight: 3 }), 6000)));
  }
  const map = maps.get(r.tag)!;
  const changed = new Set(t.changed);
  const f = path.join(AB, "artifacts", "raw", `${r.id}.stdout.ndjson`);
  if (!fs.existsSync(f)) continue;
  const c = calls(f);
  const outside = c.filter((x) => /read/.test(x.tool) && x.path).map((x) => x.path!).filter((p) => !changed.has(p) && !p.startsWith("/"));
  const unchanged = [...new Set(outside)];
  const first = outside.slice(0, 3);
  a.n++;
  a.cost += r.costUsd;
  a.calls += c.length;
  a.outK += c.reduce((n, x) => n + x.out, 0) / 1000;
  a.unchangedReads += unchanged.length;
  a.inMap += unchanged.filter((p) => map.has(p)).length;
  a.firstInMap += first.filter((p) => map.has(p)).length;
  a.firstTotal += first.length;
  a.searches += c.filter((x) => /search|grep|scout|glob/.test(x.tool)).length;
  a.findings += r.findings ?? 0;
}
console.log("arm            runs  $/run  calls/run  searches/run  toolOutK/run  unchanged-files/run  in-6K-map  first-3-outside-reads-in-map  findings/run");
for (const arm of ARMS) {
  const a = agg[arm]!;
  if (!a.n) continue;
  console.log(`${arm.padEnd(14)} ${String(a.n).padStart(4)}  ${(a.cost / a.n).toFixed(2)}  ${(a.calls / a.n).toFixed(1).padStart(9)}  ${(a.searches / a.n).toFixed(1).padStart(12)}  ${(a.outK / a.n).toFixed(0).padStart(12)}  ${(a.unchangedReads / a.n).toFixed(1).padStart(19)}  ${`${a.inMap}/${a.unchangedReads}`.padStart(9)}  ${`${a.firstInMap}/${a.firstTotal}`.padStart(28)}  ${(a.findings / a.n).toFixed(1)}`);
}
