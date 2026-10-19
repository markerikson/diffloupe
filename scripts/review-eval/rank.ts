// Reimplementation of buildDiffSeededMap's scoring (src/review/core/build-map.ts) with
// switchable additions, for offline recall experiments. With no options it reproduces
// the Related section of the maps saved by real runs.
import fs from "node:fs";
import path from "node:path";
import { diffLines } from "../../src/review/core/lib/hunks.ts";
import { detectLanguage } from "../../src/review/core/lib/languages.ts";
import { GENERIC_IDENTS } from "../../src/review/core/build-map.ts";
import type { FileOutline } from "../../src/review/core/lib/code-outline.ts";
import { DATA, TREES, git, repoFor, type Target } from "./env.ts";

export interface Prepared {
  t: Target;
  tree: string;
  all: string[];
  outlines: Map<string, FileOutline>;
  importedBy: Map<string, Set<string>>;
  symbolIndex: Map<string, string[]>;
  diffU0: string;
  diffU4: string;
  /** file -> identifier tokens, filled lazily */
  tokens: Map<string, Set<string>>;
  /** tracked non-code text files eligible as string-link candidates */
  textFiles: string[];
  fileText: Map<string, string>;
}

const TEXT_EXT = /\.(json|ya?ml|toml|md|txt|sql|sh|graphql|proto|env|ini|cfg|conf)$|(^|\/)(Dockerfile|Makefile|netlify\.toml)$/;

export function prepare(t: Target): Prepared {
  const key = t.head.slice(0, 12);
  const { all, outlines: list } = JSON.parse(fs.readFileSync(path.join(DATA, `outlines-${key}.json`), "utf8")) as {
    all: string[];
    outlines: FileOutline[];
  };
  const outlines = new Map(list.map((o) => [o.path, o]));
  const importedBy = new Map<string, Set<string>>();
  for (const [p, o] of outlines) for (const dep of o.imports ?? []) {
    if (!importedBy.has(dep)) importedBy.set(dep, new Set());
    importedBy.get(dep)!.add(p);
  }
  const symbolIndex = new Map<string, string[]>();
  for (const [p, o] of outlines) for (const s of o.symbols ?? []) {
    if (s.kind === "variable" && !s.exported) continue;
    const arr = symbolIndex.get(s.name);
    if (arr) {
      if (arr.length < 8) arr.push(p);
    } else symbolIndex.set(s.name, [p]);
  }
  const repo = repoFor(t);
  const textFiles = all.filter((p) => TEXT_EXT.test(p) && !p.includes("node_modules/") && !/lock\.(json|ya?ml)$|package-lock/.test(p));
  return {
    t, tree: path.join(TREES, key), all, outlines, importedBy, symbolIndex,
    diffU0: git(repo, ["diff", "-U0", `${t.base}..${t.head}`]),
    diffU4: git(repo, ["diff", "-U4", `${t.base}..${t.head}`]),
    tokens: new Map(), textFiles, fileText: new Map(),
  };
}

function readFile(P: Prepared, p: string): string {
  let s = P.fileText.get(p);
  if (s === undefined) {
    try {
      s = fs.readFileSync(path.join(P.tree, p), "utf8");
    } catch {
      s = "";
    }
    if (s.length > 2_000_000) s = "";
    P.fileText.set(p, s);
  }
  return s;
}

function tokensOf(P: Prepared, p: string): Set<string> {
  let s = P.tokens.get(p);
  if (!s) {
    s = new Set(readFile(P, p).match(/[A-Za-z0-9_$]+/g) ?? []);
    P.tokens.set(p, s);
  }
  return s;
}

export interface RankOptions {
  /** changed files to seed from (default: all changed files) */
  seeds?: string[];
  /** scale import edges by sqrt(min(1, 3 / importer count)) */
  damp?: boolean;
  /** second import hop from the seeds, damped and halved */
  hop2?: boolean;
  /** links through distinctive string literals on added lines, including non-code text files */
  strings?: boolean;
  stringWeight?: number;
}

export interface Ranked {
  path: string;
  score: number;
  why: string[];
}

const damping = (P: Prepared, target: string) => Math.sqrt(Math.min(1, 3 / Math.max(1, P.importedBy.get(target)?.size ?? 1)));

export function rank(P: Prepared, o: RankOptions = {}): Ranked[] {
  const changed = P.t.changed;
  const changedSet = new Set(changed);
  const seeds = o.seeds ?? changed;
  const seedSet = new Set(seeds);
  const score = new Map<string, number>();
  const why = new Map<string, Set<string>>();
  const bump = (p: string, n: number, reason: string, allowText = false) => {
    if (changedSet.has(p)) return;
    if (!P.outlines.has(p) && !allowText) return;
    score.set(p, (score.get(p) ?? 0) + n);
    if (!why.has(p)) why.set(p, new Set());
    why.get(p)!.add(reason);
  };

  for (const c of seeds) {
    for (const imp of P.outlines.get(c)?.imports ?? []) bump(imp, 6 * (o.damp ? damping(P, imp) : 1), "imported by a changed file");
    for (const dep of P.importedBy.get(c) ?? []) bump(dep, 5, "imports a changed file");
  }
  if (o.hop2) {
    const hop1 = new Set<string>();
    for (const c of seeds) for (const imp of P.outlines.get(c)?.imports ?? []) if (!changedSet.has(imp)) hop1.add(imp);
    for (const h of hop1) for (const imp of P.outlines.get(h)?.imports ?? []) {
      if (hop1.has(imp)) continue;
      bump(imp, 3 * damping(P, h) * damping(P, imp), "imported two hops out");
    }
  }

  const inSeeds = (file: string | undefined) => !!file && seedSet.has(file);
  const idents = new Set<string>();
  for (const { file, line } of diffLines(P.diffU0)) {
    if (!file || !detectLanguage(file) || !inSeeds(file)) continue;
    if (line.startsWith("+++ ")) continue;
    if (!/^[+-]/.test(line)) continue;
    for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) idents.add(m[0]);
  }
  const siblingIdents = new Set<string>();
  const lines = [...diffLines(P.diffU4)];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]!;
    if (!cur.line.startsWith("+") || cur.line.startsWith("+++")) continue;
    if (!cur.file || !detectLanguage(cur.file) || !inSeeds(cur.file)) continue;
    for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 4); j++) {
      const near = lines[j]!;
      if (near.file !== cur.file || !near.line.startsWith(" ")) continue;
      for (const m of near.line.matchAll(/[A-Za-z_][A-Za-z0-9_]{7,}/g)) {
        const id = m[0];
        if (GENERIC_IDENTS.has(id.toLowerCase())) continue;
        if (!/[A-Z_]/.test(id)) continue;
        if (P.symbolIndex.has(id)) siblingIdents.add(id);
      }
    }
  }
  const changedDefines = new Set<string>();
  for (const c of changed) for (const s of P.outlines.get(c)?.symbols ?? []) changedDefines.add(s.name);

  if (siblingIdents.size) {
    const hits = new Map<string, Set<string>>();
    for (const [p] of P.outlines) {
      if (changedSet.has(p)) continue;
      const toks = tokensOf(P, p);
      for (const id of siblingIdents) if (toks.has(id)) {
        if (!hits.has(p)) hits.set(p, new Set());
        hits.get(p)!.add(id);
      }
    }
    const spread = new Map<string, number>();
    for (const s of hits.values()) for (const id of s) spread.set(id, (spread.get(id) ?? 0) + 1);
    for (const [p, ids] of hits) for (const id of ids) {
      const n = spread.get(id)!;
      if (n > 12) continue;
      bump(p, n <= 4 ? 8 : 4, `also references \`${id}\``);
    }
  }

  for (const id of idents) {
    if (id.length < 6) continue;
    if (GENERIC_IDENTS.has(id) || GENERIC_IDENTS.has(id.toLowerCase())) continue;
    if (!/[A-Z_]/.test(id)) continue;
    if (changedDefines.has(id)) continue;
    const defs = P.symbolIndex.get(id);
    if (!defs || defs.length > 3) continue;
    for (const d of defs) bump(d, defs.length === 1 ? 4 : 2, `defines \`${id}\``);
  }

  if (o.strings) {
    // Distinctive string literals on added lines: kebab/snake/dotted keys and quoted names.
    const lits = new Set<string>();
    for (const { file, line } of diffLines(P.diffU0)) {
      if (!file || !inSeeds(file) || !line.startsWith("+") || line.startsWith("+++")) continue;
      for (const m of line.matchAll(/["'`]([A-Za-z][A-Za-z0-9]*(?:[-_.:/][A-Za-z0-9]+)+)["'`]/g)) {
        const s = m[1]!;
        if (s.length < 6 || s.length > 60) continue;
        if (/^(https?|node|bun):|\.(ts|tsx|js|json|md)$|^\.\.?\//.test(s)) continue;
        lits.add(s);
      }
    }
    if (lits.size) {
      const candidates = [...P.outlines.keys(), ...P.textFiles].filter((p) => !changedSet.has(p));
      const w = o.stringWeight ?? 6;
      for (const lit of lits) {
        const files: string[] = [];
        for (const p of candidates) if (readFile(P, p).includes(lit)) {
          files.push(p);
          if (files.length > 15) break;
        }
        if (files.length === 0 || files.length > 15) continue;
        for (const f of files) bump(f, files.length <= 5 ? w : w / 2, `mentions "${lit}"`, true);
      }
    }
  }

  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([p, s]) => ({ path: p, score: s, why: [...(why.get(p) ?? [])] }));
}

/** Approximate rendered tokens for one file, as build-map renders it. */
export function renderTokens(P: Prepared, p: string): number {
  const o = P.outlines.get(p);
  if (!o) return 20;
  const syms = (o.symbols ?? []).filter((s) => s.exported || o.language === "cpp" || s.kind !== "variable");
  const chars = 40 + p.length + syms.slice(0, 40).reduce((n, s) => n + 12 + (s.signature || s.name).length, 0);
  return Math.ceil(chars / 3.6);
}

/** Paths that fit in `budget` tokens of related-file outlines. */
export function fit(P: Prepared, ranked: Array<{ path: string }>, budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const r of ranked) {
    const t = renderTokens(P, r.path);
    if (used + t > budget) break;
    used += t;
    out.push(r.path);
  }
  return out;
}

/** Related budget left after the header, layout and changed-file outlines of the 14K whole-diff map. */
export function relatedBudget(P: Prepared, total = 14000): number {
  let changed = 0;
  for (const c of P.t.changed) if (P.outlines.has(c)) {
    const t = renderTokens(P, c);
    if (changed + t > total * 0.5) break;
    changed += t;
  }
  return total - 900 - changed;
}
