/**
 * Deterministic titles for computed groups, used when no model names them.
 * A title names the group's files rather than its directories, since sibling
 * groups often share a directory: one file reads `cli/doctor`, two read
 * `models, model-catalog`, and more read `runner +6`, led by the file with
 * the most changed lines. Tests fold into the file they test, and generic
 * names such as `index` or `types` keep their parent directory.
 */
import { posix } from "node:path";

/** Roughly what the sidebar shows before it truncates. */
const MAX_LENGTH = 24;

const CODE_EXT =
  /\.(?:c|cc|cpp|cs|css|cts|cjs|go|h|hpp|java|js|jsx|kt|less|mjs|mts|php|py|rb|rs|sass|scss|svelte|swift|ts|tsx|vue)$/i;

const GENERIC = new Set([
  "__init__",
  "common",
  "constants",
  "helpers",
  "index",
  "init",
  "lib",
  "main",
  "mod",
  "shared",
  "types",
  "util",
  "utils",
]);

interface Entry {
  path: string;
  label: string;
  weight: number;
}

function parentDir(path: string): string | undefined {
  const dir = posix.dirname(path);
  return dir === "." ? undefined : posix.basename(dir);
}

/** `runner.test.ts` and `runner.ts` both give `runner`; `package.json` stays `package.json`. */
function label(path: string): string {
  const base = posix.basename(path);
  if (!CODE_EXT.test(base)) return base;
  const name = base.replace(CODE_EXT, "").replace(/\.d$/, "");
  const dir = parentDir(path);
  return GENERIC.has(name.toLowerCase()) && dir ? `${dir}/${name}` : name;
}

function subjectOf(path: string): string {
  return path.replace(/[._-](?:test|spec)(\.[^./]+)$/, "$1");
}

function entries(files: string[], weight: (file: string) => number): Entry[] {
  const bySubject = new Map<string, Entry>();
  for (const f of files) {
    const path = subjectOf(f);
    const entry = bySubject.get(path) ?? { path, label: label(path), weight: 0 };
    entry.weight += weight(f);
    bySubject.set(path, entry);
  }
  return [...bySubject.values()].sort((a, b) => b.weight - a.weight);
}

/** `doctor` → `cli/doctor`, unless the label already has a directory or gets too long. */
function qualify(entry: Entry): string {
  const dir = parentDir(entry.path);
  if (!dir || entry.label.includes("/")) return entry.label;
  const out = `${dir}/${entry.label}`;
  return out.length <= MAX_LENGTH ? out : entry.label;
}

function titleFrom(list: Entry[], qualified: boolean): string {
  const [first, second] = list;
  if (!first) return "Files";
  const lead = qualified ? qualify(first) : first.label;
  if (list.length === 1) return qualify(first);
  if (list.length === 2 && second) {
    const pair = `${lead}, ${second.label}`;
    if (pair.length <= MAX_LENGTH) return pair;
  }
  return `${lead} +${list.length - 1}`;
}

export function groupTitle(files: string[], weight: (file: string) => number = () => 0): string {
  return titleFrom(entries(files, weight), false);
}

/**
 * One title per group. Groups that would share a title get the leading file's
 * directory, then " (2)", " (3)" for any still repeated.
 */
export function groupTitles(groups: { files: string[] }[], weight: (file: string) => number = () => 0): string[] {
  const lists = groups.map((g) => entries(g.files, weight));
  const titles = lists.map((l) => titleFrom(l, false));
  const count = (ts: string[]) => {
    const n = new Map<string, number>();
    for (const t of ts) n.set(t, (n.get(t) ?? 0) + 1);
    return n;
  };
  const first = count(titles);
  const qualified = titles.map((t, i) => ((first.get(t) ?? 0) > 1 ? titleFrom(lists[i] ?? [], true) : t));
  const seen = new Map<string, number>();
  return qualified.map((t) => {
    const n = (seen.get(t) ?? 0) + 1;
    seen.set(t, n);
    return n === 1 ? t : `${t} (${n})`;
  });
}
