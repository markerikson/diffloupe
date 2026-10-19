// Offline recall of map rankings. Ground truth per target and slice: unchanged files
// cited by findings and unchanged files the slice agents read. Scores the whole-diff map
// (current 14K budget and 3K) and per-slice maps seeded from the slice's own files.
import fs from "node:fs";
import path from "node:path";
import { prepare, rank, fit, relatedBudget, type RankOptions, type Prepared } from "./rank.ts";
import { ARTIFACTS, DATA, loadTargets, type Target } from "./env.ts";

function savedRelated(t: Target): string[] {
  const f = path.join(ARTIFACTS, "maps", `range-${t.base.slice(0, 12)}-${t.head.slice(0, 12)}.md`);
  if (!fs.existsSync(f)) return [];
  let section = "";
  const out: string[] = [];
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (line.startsWith("## ")) section = line;
    const m = line.match(/^### (\S+)/);
    if (m && section.startsWith("## Related")) out.push(m[1]!);
  }
  return out;
}

const algos: Record<string, RankOptions> = {
  current: {},
  damp: { damp: true },
  "damp+hop2": { damp: true, hop2: true },
  strings: { strings: true, stringWeight: 3 },
  "damp+hop2+strings": { damp: true, hop2: true, strings: true, stringWeight: 3 },
};

type Row = { target: string; algo: string; scope: string; budget: number; truthCited: number; hitCited: number; truthRead: number; hitRead: number; listed: number };
const rows: Row[] = [];
const recall = (list: string[], truth: string[]) => truth.filter((f) => list.includes(f)).length;

for (const t of loadTargets()) {
  const t0 = Date.now();
  const P: Prepared = prepare(t);
  const saved = savedRelated(t);
  const wholeBudget = relatedBudget(P);
  const mine = fit(P, rank(P, {}), wholeBudget);
  // Overlap with the map the run saved checks that rank() still matches build-map.
  const overlap = saved.length ? mine.filter((p) => saved.includes(p)).length / saved.length : NaN;
  console.log(`${t.id} saved=${saved.length} mine=${mine.length} overlap=${overlap.toFixed(2)} cited=${recall(mine, t.cited)}/${t.cited.length}`);

  for (const [algo, opts] of Object.entries(algos)) {
    const ranked = rank(P, opts);
    for (const budget of [wholeBudget, 3000]) {
      const list = fit(P, ranked, budget);
      rows.push({ target: t.id, algo, scope: "whole", budget: budget === 3000 ? 3000 : 14000, truthCited: t.cited.length, hitCited: recall(list, t.cited), truthRead: t.read.length, hitRead: recall(list, t.read), listed: list.length });
    }
    for (const s of t.slices) {
      if (!s.files.length || (!s.cited.length && !s.read.length)) continue;
      const sliceRanked = rank(P, { ...opts, seeds: s.files });
      for (const budget of [1500, 3000, 6000]) {
        const list = fit(P, sliceRanked, budget);
        rows.push({ target: `${t.id}:${s.tag}`, algo, scope: "slice", budget, truthCited: s.cited.length, hitCited: recall(list, s.cited), truthRead: s.read.length, hitRead: recall(list, s.read), listed: list.length });
      }
    }
    if (algo === "current") for (const s of t.slices) {
      if (!s.cited.length && !s.read.length) continue;
      rows.push({ target: `${t.id}:${s.tag}`, algo, scope: "slice", budget: 14000, truthCited: s.cited.length, hitCited: recall(mine, s.cited), truthRead: s.read.length, hitRead: recall(mine, s.read), listed: mine.length });
    }
  }
  console.log(`  ${Date.now() - t0} ms`);
}
fs.writeFileSync(path.join(DATA, "map-rows.json"), JSON.stringify(rows, null, 1));

const agg = new Map<string, { c: number; tc: number; r: number; tr: number; n: number; listed: number }>();
for (const r of rows) {
  const k = `${r.scope.padEnd(5)} ${String(r.budget).padStart(5)} ${r.algo}`;
  const a = agg.get(k) ?? { c: 0, tc: 0, r: 0, tr: 0, n: 0, listed: 0 };
  a.c += r.hitCited;
  a.tc += r.truthCited;
  a.r += r.hitRead;
  a.tr += r.truthRead;
  a.n++;
  a.listed += r.listed;
  agg.set(k, a);
}
const pct = (a: number, b: number) => `${a}/${b} (${((100 * a) / Math.max(1, b)).toFixed(0)}%)`;
console.log("\nscope budget algo                    cited          read           avg files listed");
for (const [k, a] of [...agg.entries()].sort()) {
  console.log(k.padEnd(36), pct(a.c, a.tc).padEnd(14), pct(a.r, a.tr).padEnd(14), (a.listed / a.n).toFixed(1));
}
