import { SEVERITY_ORDER } from "../../review/export.ts";
import type { GuideStop, ReviewRun, RunFile, RunFinding } from "../../types/review-run.ts";
import type { GroupTree } from "./group-tree.ts";

export interface NavLists {
  /** Files in page order. */
  files: RunFile[];
  /** Findings whose file is on the page, in page order. */
  findings: RunFinding[];
  /** Walkthrough stops in guide order. */
  stops: GuideStop[];
}

export interface NavOptions {
  showOverCap?: boolean;
  /** Finding ids to leave out, such as dismissed ones. */
  hidden?: ReadonlySet<string>;
}

export function filesInPageOrder(files: readonly RunFile[], tree: Pick<GroupTree, "ordered">): RunFile[] {
  const byGroup = new Map<string, RunFile[]>();
  for (const f of files) {
    const list = byGroup.get(f.groupId);
    if (list) list.push(f);
    else byGroup.set(f.groupId, [f]);
  }
  return tree.ordered.flatMap((g) => byGroup.get(g.id) ?? []);
}

export function navLists(
  run: Pick<ReviewRun, "files" | "findings" | "overCapFindings" | "stops">,
  tree: Pick<GroupTree, "ordered">,
  opts: NavOptions = {},
): NavLists {
  const files = filesInPageOrder(run.files, tree);
  const fileIndex = new Map(files.map((f, i) => [f.path, i]));
  const all = opts.showOverCap ? [...run.findings, ...run.overCapFindings] : run.findings;
  const lineOf = (f: RunFinding) => (f.anchor.kind === "file" ? 0 : f.anchor.line);
  const findings = all
    .filter((f) => fileIndex.has(f.anchor.file) && !opts.hidden?.has(f.id))
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        fileIndex.get(a.f.anchor.file)! - fileIndex.get(b.f.anchor.file)! ||
        lineOf(a.f) - lineOf(b.f) ||
        SEVERITY_ORDER.indexOf(a.f.severity) - SEVERITY_ORDER.indexOf(b.f.severity) ||
        a.i - b.i,
    )
    .map(({ f }) => f);
  return { files, findings, stops: [...run.stops] };
}

/**
 * The id after (`dir` 1) or before (`dir` -1) `current` in `ids`. Stops at the
 * ends instead of wrapping. With no current id, starts at the first item.
 */
export function neighbor(ids: readonly string[], current: string | undefined, dir: 1 | -1): string | undefined {
  if (!ids.length) return undefined;
  const i = current === undefined ? -1 : ids.indexOf(current);
  if (i === -1) return ids[0];
  return ids[i + dir];
}
