#!/usr/bin/env bun
/**
 * Diff-seeded repo map.
 *
 * Unlike the general repo-map (recency/churn/PageRank ranked), this selects files
 * by their relationship to a specific diff:
 *   1. changed files themselves
 *   2. files that import a changed file      (reverse import edges)
 *   3. files a changed file imports          (forward import edges)
 *   4. files defining symbols the diff references (Snap CodePal pass-2 symbol overlap)
 * then outlines that set under a token budget.
 */
import path from "node:path";
import type { FileOutline } from "./lib/code-outline.ts";
import { diffLines } from "./lib/hunks.ts";
import { detectLanguage } from "./lib/languages.ts";
import { projectFilesFromGit, resolveOutlineImports } from "./lib/module-resolver.ts";
import { text } from "./lib/proc.ts";
import { readText } from "./lib/io.ts";
import { EXTRA_EXCLUDES } from "./config.ts";

type Outline = FileOutline;

const EXCLUDE = [
  "node_modules/", "/dist/", "/build/", "/.next/", "/__snapshots__/",
  ".min.js", ".d.ts", ".js.map", "third-party/",
];

/**
 * Identifiers too generic for symbol-overlap retrieval. These appear as method or
 * property names across unrelated files, so a match carries no signal about
 * which file is relevant to the diff.
 */
export const GENERIC_IDENTS = new Set([
  "length", "name", "data", "value", "values", "result", "results", "error", "index",
  "sort", "update", "commit", "title", "stringify", "parse", "resume", "first", "last",
  "evaluate", "process", "context", "options", "config", "state", "status", "start",
  "stop", "close", "open", "read", "write", "size", "count", "type", "kind", "path",
  "file", "line", "text", "message", "handler", "callback", "toString", "constructor",
  "entries", "keys", "items", "list", "item", "node", "root", "child", "children",
  "params", "args", "props", "info", "detail", "details", "target", "source", "output",
  "input", "buffer", "offset", "reset", "clear", "flush", "init", "create", "destroy",
]);

function excluded(p: string) {
  // A leading slash means "a path segment anywhere", which `includes` already
  // does once the slash is part of the needle. A bare entry matches a suffix or
  // a top-level directory too, so it also has to match at the start.
  return [...EXCLUDE, ...EXTRA_EXCLUDES].some((e) => p.includes(e) || (!e.startsWith("/") && p.startsWith(e)));
}

export interface MapOptions {
  repo: string;
  base: string;
  head: string;
  budgetTokens?: number;
}

const approxTokens = (s: string) => Math.ceil(s.length / 3.6);

export async function buildDiffSeededMap(opts: MapOptions): Promise<{ markdown: string; meta: Record<string, unknown> }> {
  const { repo, base, head } = opts;
  const budget = opts.budgetTokens ?? 14000;
  const t0 = Date.now();

  const changed = (await text("git", ["-C", repo, "-c", "diff.renames=true", "diff", "--name-only", `${base}..${head}`]))
    .split("\n").map((s) => s.trim()).filter(Boolean);
  const changedSet = new Set(changed);

  const tracked = (await text("git", ["-C", repo, "ls-files"]))
    .split("\n").map((s) => s.trim())
    .filter((p) => p && !excluded(p) && detectLanguage(p) !== null);

  // Loaded here rather than at module scope: this is the only code in the
  // pipeline that needs the tree-sitter grammars, and a missing grammar should
  // cost the caller its map, not its review.
  const { OutlineExtractor } = await import("./lib/code-outline.ts");
  const extractor = await OutlineExtractor.create();
  await extractor.warmup(["typescript", "tsx", "cpp"]);

  const outlines = new Map<string, Outline>();
  const tParse = Date.now();
  for (const rel of tracked) {
    try {
      const o = await extractor.parseFile(path.join(repo, rel), rel, repo);
      if (o) outlines.set(rel, o);
    } catch { /* unparseable file: skipped, counted via tracked-vs-outlines delta */ }
  }
  const parseMs = Date.now() - tParse;
  const resolver = resolveOutlineImports([...outlines.values()], projectFilesFromGit(repo));

  // import graph
  const importedBy = new Map<string, Set<string>>();
  for (const [p, o] of outlines) {
    for (const dep of o.imports ?? []) {
      if (!importedBy.has(dep)) importedBy.set(dep, new Set());
      importedBy.get(dep)!.add(p);
    }
  }

  // symbol -> defining files
  const symbolIndex = new Map<string, string[]>();
  for (const [p, o] of outlines) {
    for (const s of o.symbols ?? []) {
      // A function-local `const` is a `variable` the same way an exported
      // registry object is, and there are far more of the former: indexing both
      // adds roughly eleven thousand names to this repository's index, nearly
      // all of them locals that say nothing about which file a diff identifier
      // belongs to. A name like `result` or `entries` then resolves to whichever
      // eight files happened to declare it first. Functions and classes are
      // indexed whether exported or not, because a private helper's name is
      // still that file's own; a local binding's name is not.
      if (s.kind === "variable" && !s.exported) continue;
      const arr = symbolIndex.get(s.name);
      if (arr) { if (arr.length < 8) arr.push(p); } else symbolIndex.set(s.name, [p]);
    }
  }

  // identifiers appearing on added/removed diff lines
  const diffText = await text("git", ["-C", repo, "-c", "diff.renames=true", "diff", "-U0", `${base}..${head}`]);
  const idents = new Set<string>();
  for (const { file, line } of diffLines(diffText)) {
    // The index holds symbols from parsed source files only, so a name taken
    // from a lockfile, a changelog or generated JSON can match one only by
    // coincidence — and those files are usually the largest in a diff, so
    // they dominate a scan that treats every line the same.
    if (!file || !detectLanguage(file)) continue;
    // The `+++` header names the file and is yielded alongside it, so it looks
    // like an added line. Its identifiers are path fragments, not code.
    if (line.startsWith("+++ ")) continue;
    if (!/^[+-]/.test(line)) continue;
    for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) idents.add(m[0]);
  }

  /**
   * Sibling identifiers: names on unchanged context lines directly around added
   * lines. When a change registers a new entry into a list, its siblings sit on
   * those context lines, and the files that also reference a sibling are the
   * other places the new entry probably needs to be registered. This is the
   * signal that catches "added to one registry but not its siblings".
   */
  const ctxDiff = await text("git", ["-C", repo, "-c", "diff.renames=true", "diff", "-U4", `${base}..${head}`]);
  const siblingIdents = new Set<string>();
  {
    // Read through `diffLines` rather than off the raw text, for the file the
    // identifier pass above filters on: a registry sits in source, and a
    // lockfile or generated bundle contributes long capitalised strings by the
    // thousand that are siblings of nothing. The window is taken over the parsed
    // lines so an entry's neighbours are still its neighbours.
    const lines = [...diffLines(ctxDiff)];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].line.startsWith("+") || lines[i].line.startsWith("+++")) continue;
      if (!lines[i].file || !detectLanguage(lines[i].file!)) continue;
      for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 4); j++) {
        // The window is positional over one flat array spanning the whole diff,
        // so near a file boundary it reaches into the neighbouring file's last
        // hunk — including a file the language gate on `lines[i]` never saw.
        if (lines[j].file !== lines[i].file) continue;
        const l = lines[j].line;
        if (!l.startsWith(" ")) continue;
        for (const m of l.matchAll(/[A-Za-z_][A-Za-z0-9_]{7,}/g)) {
          const id = m[0];
          if (GENERIC_IDENTS.has(id.toLowerCase())) continue;
          // Same rule the symbol pass applies: a bare lowercase word is a
          // common noun, and the outline indexes class and interface members by
          // bare name. Without it `throttle` on a context line pulls in every
          // file that happens to define a method by that name.
          if (!/[A-Z_]/.test(id)) continue;
          if (changedSet.size && symbolIndex.has(id)) siblingIdents.add(id);
        }
      }
    }
  }

  const score = new Map<string, number>();
  const why = new Map<string, Set<string>>();
  const bump = (p: string, n: number, reason: string) => {
    if (!outlines.has(p) || changedSet.has(p)) return;
    score.set(p, (score.get(p) ?? 0) + n);
    if (!why.has(p)) why.set(p, new Set());
    why.get(p)!.add(reason);
  };

  for (const c of changed) {
    for (const imp of outlines.get(c)?.imports ?? []) bump(imp, 6, "imported by a changed file");
    for (const dep of importedBy.get(c) ?? []) bump(dep, 5, "imports a changed file");
  }
  const changedDefines = new Set<string>();
  for (const c of changed) for (const s of outlines.get(c)?.symbols ?? []) changedDefines.add(s.name);

  // Which unchanged files mention a sibling identifier?
  //
  // Whole-token matching, not substring containment. The sibling signal is this
  // map's answer to "added to one registry but not its siblings", and its value
  // rests on the spread count being the number of files that really mention a
  // name. `content.includes("Fork")` is true of any file mentioning
  // `ForkProcess`, which both scores unrelated files into the related list and
  // inflates spread past the cutoff below, discarding the distinctive siblings
  // that carry the signal.
  const siblingHits = new Map<string, Set<string>>();
  if (siblingIdents.size) {
    const pats = [...siblingIdents];
    for (const [p] of outlines) {
      if (changedSet.has(p)) continue;
      let content: string;
      try { content = await readText(path.join(repo, p)); } catch { continue; }
      if (content.length > 2_000_000) continue;
      const tokens = new Set(content.match(/[A-Za-z0-9_$]+/g) ?? []);
      for (const id of pats) {
        if (tokens.has(id)) {
          if (!siblingHits.has(p)) siblingHits.set(p, new Set());
          siblingHits.get(p)!.add(id);
        }
      }
    }
  }
  for (const [p, hitIds] of siblingHits) {
    // Rare siblings are strong evidence; ubiquitous ones are not.
    for (const id of hitIds) {
      const spread = [...siblingHits.values()].filter((s) => s.has(id)).length;
      if (spread > 12) continue;
      bump(p, spread <= 4 ? 8 : 4, `also references \`${id}\``);
    }
  }

  for (const id of idents) {
    if (id.length < 6) continue;
    if (GENERIC_IDENTS.has(id) || GENERIC_IDENTS.has(id.toLowerCase())) continue;
    // A bare lowercase word is a common noun, and matching one says nothing about
    // where a change belongs. `symbolIndex` keys every symbol by its bare name,
    // including class and interface members, so a GraphQL builder with methods
    // named `string`, `object` and `boolean` outranked every genuinely related
    // file on this repo's own review PR. A capital or an underscore is the cheap
    // corpus-free test for a name somebody coined rather than a word they reused;
    // an enumerated stop-list loses to English one word at a time.
    if (!/[A-Z_]/.test(id)) continue;
    // A symbol the diff already defines locally tells us nothing about other files.
    if (changedDefines.has(id)) continue;
    const defs = symbolIndex.get(id);
    if (!defs || defs.length > 3) continue; // ubiquitous names carry no locality signal
    const weight = defs.length === 1 ? 4 : 2;
    for (const d of defs) bump(d, weight, `defines \`${id}\``);
  }

  const rankedScored = [...score.entries()].sort((a, b) => b[1] - a[1]);
  const ranked = rankedScored.map(([p]) => p);
  if (process.env.MAP_DEBUG) {
    for (const [p, s] of rankedScored.slice(0, 30)) {
      console.error(String(s).padStart(4), p, "|", [...(why.get(p) ?? [])].slice(0, 4).join("; "));
    }
  }

  const render = (p: string, tag: string) => {
    const o = outlines.get(p);
    if (!o) return "";
    // Same rule as `symbolIndex`: everything except unexported variables. A file
    // is often selected *because* of a private function — the index keeps those
    // on purpose, and the sibling pass requires no export at all — so rendering
    // exports only turns such a file into a bare header with nothing under it,
    // while `relatedRendered` still counts it as covered.
    const syms = (o.symbols ?? []).filter(
      (s) => s.exported || o.language === "cpp" || s.kind !== "variable",
    );
    const lines = syms.slice(0, 40).map((s) => `  ${s.line} ${s.kind} ${s.signature || s.name}`);
    const more = syms.length > 40 ? `  … ${syms.length - 40} more\n` : "";
    return `### ${p} (${o.lines} lines)${tag}\n${lines.join("\n")}\n${more}`;
  };

  const parts: string[] = [];
  let used = 0;
  const push = (s: string, cap = budget) => {
    const t = approxTokens(s);
    if (used + t > cap) return false;
    parts.push(s); used += t; return true;
  };

  // Codebase shape: directory rollup so the agent knows the layout before it searches.
  const dirAgg = new Map<string, { files: number; symbols: number }>();
  for (const [p, o] of outlines) {
    const parts = p.split("/");
    const key = parts.slice(0, Math.min(3, parts.length - 1)).join("/") || ".";
    const cur = dirAgg.get(key) ?? { files: 0, symbols: 0 };
    cur.files++; cur.symbols += (o.symbols ?? []).length;
    dirAgg.set(key, cur);
  }
  const layout = [...dirAgg.entries()]
    .sort((a, b) => b[1].files - a[1].files).slice(0, 45)
    .map(([d, s]) => `  ${d}/  ${s.files} files, ${s.symbols} symbols`).join("\n");

  push(`# Repo map for this change\n\nOrientation for reviewing this diff, so you do not have to discover the codebase from scratch. Outlines list exported symbols with signatures; use your file-read tool for bodies. This map is incomplete by construction — the file that confirms or disproves a finding may not appear here. Search for what it does not contain.\n`);
  push(`## Codebase layout (parsed source only, ${outlines.size} files, ${symbolIndex.size} distinct symbol names)\n\n\`\`\`\n${layout}\n\`\`\`\n`);

  // Reserve budget for related files: changed-file outlines are the least valuable
  // part of the map, since the agent already has the diff for those.
  const changedCap = Math.floor(budget * 0.5);
  push(`## Changed files\n`, changedCap);
  let changedRendered = 0;
  for (const c of changed) if (outlines.has(c) && push(render(c, ""), changedCap)) changedRendered++;

  push(`\n## Related files (not changed by this PR)\n`);
  let relatedRendered = 0;
  for (const p of ranked) {
    const tag = ` — ${[...(why.get(p) ?? [])].slice(0, 3).join("; ")}`;
    if (!push(render(p, tag))) break;
    relatedRendered++;
  }

  return {
    markdown: parts.join("\n"),
    meta: {
      base, head, changedFiles: changed.length, trackedParsed: outlines.size,
      symbolsIndexed: symbolIndex.size, diffIdentifiers: idents.size,
      candidatesScored: score.size, changedRendered, relatedRendered,
      approxTokens: used, parseMs, totalMs: Date.now() - t0,
      inferredAliases: resolver.aliases.map((a) => `${a.scope || "."}: ${a.prefix} -> ${a.root || "."}`),
    },
  };
}
