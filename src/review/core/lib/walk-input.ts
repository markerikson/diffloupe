/**
 * What the walkthrough is given when the whole diff does not fit its budget.
 *
 * Filling the budget with whole files in slice order spent it on the first few
 * groups: on #13157 the guide read 45 of 112 files and knew nothing about the
 * rest beyond their line counts, so the chapters for unread groups were guesses
 * from a title. Here the budget is shared across groups first, and every file
 * that is not shown gets a sketch built from the diff itself: lines added and
 * removed, names it defines on added lines, and the functions its hunks fall in.
 */
import type { FileFacts, Link } from "./grouping.ts";
import { describeLink } from "./grouping.ts";
import { diffLines } from "./hunks.ts";

export interface FileSketch {
  file: string;
  added: number;
  removed: number;
  /** Names defined on added lines. */
  defines: string[];
  /** Enclosing functions of the hunks, from git's hunk headers, with the first new-side line. */
  touches: { name: string; line: number }[];
}

const CONTROL_WORDS = new Set([
  "if", "for", "while", "switch", "return", "catch", "function", "new", "await", "typeof", "sizeof",
]);

/** The function a hunk header's context line names, if any. */
export function hunkContextName(context: string): string | undefined {
  for (const m of context.matchAll(/([A-Za-z_$~][\w$]*(?:::~?[A-Za-z_$][\w$]*)*)\s*(?:[(<]|=\s*(?:async\s*)?\()/g)) {
    if (!CONTROL_WORDS.has(m[1])) return m[1];
  }
  const decl = /\b(?:class|interface|type|enum|struct|namespace|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(context);
  return decl?.[1];
}

export function sketchFiles(diffU0: string, facts: FileFacts[]): Map<string, FileSketch> {
  const out = new Map<string, FileSketch>();
  const get = (file: string) => {
    let s = out.get(file);
    if (!s) {
      s = { file, added: 0, removed: 0, defines: [], touches: [] };
      out.set(file, s);
    }
    return s;
  };
  for (const { file, line } of diffLines(diffU0)) {
    if (!file || line.startsWith("+++ ")) continue;
    const s = get(file);
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (hunk) {
      const name = hunkContextName(hunk[2]);
      if (name && !s.touches.some((t) => t.name === name)) s.touches.push({ name, line: Number(hunk[1]) });
    } else if (line.startsWith("+")) s.added++;
    else if (line.startsWith("-")) s.removed++;
  }
  for (const f of facts) {
    const s = get(f.file);
    s.defines = f.defined;
    // A function defined in this diff is already named under `defines`.
    s.touches = s.touches.filter((t) => !f.defined.includes(t.name));
  }
  return out;
}

export function sketchLine(s: FileSketch, maxNames = 6): string {
  const parts: string[] = [];
  const names = (xs: string[]) =>
    xs.slice(0, maxNames).map((n) => `\`${n}\``).join(", ") + (xs.length > maxNames ? `, +${xs.length - maxNames} more` : "");
  if (s.defines.length) parts.push(`adds ${names(s.defines)}`);
  if (s.touches.length) parts.push(`edits in ${names(s.touches.map((t) => `${t.name}@${t.line}`))}`);
  return `- \`${s.file}\` (+${s.added} −${s.removed})${parts.length ? `: ${parts.join("; ")}` : ""}`;
}

/**
 * Which files the walkthrough reads in full. Each group first gets an equal
 * share of the budget, filled largest file first so its main file is the one
 * shown; what is left then goes to the smallest remaining files from any group,
 * which covers the most files. A file over `maxFile` tokens is never shown — one
 * 61k-token file would otherwise be the whole guide.
 */
export function selectWalkFiles(
  groups: { files: string[] }[],
  fileTokens: Map<string, number>,
  budget: number,
  maxFile = Math.floor(budget / 4),
): { shown: string[]; sketched: string[] } {
  const all = groups.flatMap((g) => g.files);
  const tokens = (f: string) => fileTokens.get(f) ?? 0;
  const total = all.reduce((a, f) => a + tokens(f), 0);
  if (total <= budget) return { shown: all, sketched: [] };

  const taken = new Set<string>();
  let used = 0;
  const share = Math.floor(budget / Math.max(1, groups.length));
  for (const g of groups) {
    let groupUsed = 0;
    for (const f of [...g.files].sort((a, b) => tokens(b) - tokens(a))) {
      const t = tokens(f);
      if (t > maxFile || groupUsed + t > share || used + t > budget) continue;
      taken.add(f);
      groupUsed += t;
      used += t;
    }
  }
  for (const f of all.filter((x) => !taken.has(x)).sort((a, b) => tokens(a) - tokens(b))) {
    const t = tokens(f);
    if (t > maxFile || used + t > budget) continue;
    taken.add(f);
    used += t;
  }
  return { shown: all.filter((f) => taken.has(f)), sketched: all.filter((f) => !taken.has(f)) };
}

/** The strongest links inside one group, for the guide's reading order. */
export function groupLinkLines(files: string[], links: Link[], max = 3): string[] {
  const inside = new Set(files);
  return links
    .filter((l) => l.kind !== "dir" && inside.has(l.from) && inside.has(l.to))
    .slice(0, max)
    .map(describeLink);
}

/** Links whose two ends are in different groups, strongest first. */
export function crossGroupLinkLines(
  groups: { id: string; files: string[] }[],
  links: Link[],
  max = 20,
): string[] {
  const groupOf = new Map<string, string>();
  for (const g of groups) for (const f of g.files) groupOf.set(f, g.id);
  const out: string[] = [];
  for (const l of links) {
    if (l.kind === "dir") continue;
    const a = groupOf.get(l.from);
    const b = groupOf.get(l.to);
    if (!a || !b || a === b) continue;
    out.push(`${describeLink(l)} (${a} → ${b})`);
    if (out.length >= max) break;
  }
  return out;
}
