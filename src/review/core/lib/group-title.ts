/**
 * Deterministic titles for computed groups, used when no model names them:
 * the longest common directory of the group's files, followed by the file
 * names when there are at most three of them once tests are folded into the
 * file they test.
 */
import { posix } from "node:path";

const MAX_NAMED = 3;

function commonDir(files: string[]): string {
  const dirs = files.map((f) => posix.dirname(f).split("/").filter((s) => s !== "."));
  const first = dirs[0] ?? [];
  let n = 0;
  while (n < first.length && dirs.every((d) => d[n] === first[n])) n++;
  return first.slice(0, n).join("/");
}

/** `runner.test.ts` and `runner.ts` both give `runner`; `types.d.ts` gives `types`. */
function stem(rel: string): string {
  const dir = posix.dirname(rel);
  let name = posix.basename(rel);
  const dot = name.lastIndexOf(".");
  if (dot > 0) name = name.slice(0, dot);
  name = name.replace(/[._-](test|spec)$/, "").replace(/\.d$/, "");
  return dir === "." ? name : `${dir}/${name}`;
}

export function groupTitle(files: string[]): string {
  if (files.length === 0) return "Files";
  const dir = commonDir(files);
  const rest = files.map((f) => (dir ? f.slice(dir.length + 1) : f));
  const names = [...new Set(rest.map(stem))];
  if (names.length > MAX_NAMED) return dir || "Top-level files";
  const list = names.join(", ");
  return dir ? `${dir}: ${list}` : list;
}

/** One title per group, with " (2)", " (3)" added to repeats. */
export function groupTitles(groups: { files: string[] }[]): string[] {
  const seen = new Map<string, number>();
  return groups.map((g) => {
    const title = groupTitle(g.files);
    const n = (seen.get(title) ?? 0) + 1;
    seen.set(title, n);
    return n === 1 ? title : `${title} (${n})`;
  });
}
