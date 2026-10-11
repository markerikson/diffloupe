/**
 * Deterministic titles for computed groups, used when no model names them:
 * the longest common directory of the group's files, followed by the file
 * names when there are at most three of them once tests are folded into the
 * file they test, else by the subdirectories (and files) directly under it
 * when there are two to four of those.
 */
import { posix } from "node:path";

const MAX_NAMED = 3;
const MAX_PARTS = 4;

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
  let list = names.length <= MAX_NAMED ? names : undefined;
  if (!list && rest.some((r) => r.includes("/"))) {
    const parts = [...new Set(rest.map((r) => (r.includes("/") ? r.slice(0, r.indexOf("/")) : stem(r))))];
    if (parts.length > 1 && parts.length <= MAX_PARTS) list = parts;
  }
  if (!list) return dir || "Top-level files";
  return dir ? `${dir}: ${list.join(", ")}` : list.join(", ");
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
