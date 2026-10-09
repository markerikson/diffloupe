import type { RunFile, RunGroup } from "../../types/review-run.ts";

export interface GroupStats {
  files: number;
  additions: number;
  deletions: number;
  /** The group or any of its units is marked critical. */
  critical: boolean;
}

export interface ChapterEntry {
  /** Null for units that have no parent chapter. */
  chapter: RunGroup | null;
  units: RunGroup[];
}

export interface GroupTree {
  chapters: ChapterEntry[];
  stats: ReadonlyMap<string, GroupStats>;
  byId: ReadonlyMap<string, RunGroup>;
  /** Groups in render order: each chapter followed by its units. */
  ordered: RunGroup[];
}

/**
 * Arranges `run.groups` into chapters with their units, keeping run order.
 * Consecutive parentless units share one chapter-less entry.
 */
export function buildGroupTree(groups: readonly RunGroup[], files: readonly RunFile[]): GroupTree {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  const chapters: ChapterEntry[] = [];
  const entryFor = new Map<string, ChapterEntry>();

  for (const g of groups) {
    const parent = g.parentId === undefined ? undefined : byId.get(g.parentId);
    if (parent) {
      let entry = entryFor.get(parent.id);
      if (!entry) {
        entry = { chapter: parent, units: [] };
        entryFor.set(parent.id, entry);
        chapters.push(entry);
      }
      entry.units.push(g);
    } else if (isChapter(g, groups)) {
      if (!entryFor.has(g.id)) {
        const entry: ChapterEntry = { chapter: g, units: [] };
        entryFor.set(g.id, entry);
        chapters.push(entry);
      }
    } else {
      const last = chapters.at(-1);
      if (last && last.chapter === null) last.units.push(g);
      else chapters.push({ chapter: null, units: [g] });
    }
  }

  const stats = new Map<string, GroupStats>();
  const own = (g: RunGroup): GroupStats => {
    const s: GroupStats = { files: 0, additions: 0, deletions: 0, critical: g.critical };
    for (const p of g.files) {
      const f = fileByPath.get(p);
      s.files += 1;
      s.additions += f?.additions ?? 0;
      s.deletions += f?.deletions ?? 0;
    }
    return s;
  };
  for (const { chapter, units } of chapters) {
    const total: GroupStats = chapter ? own(chapter) : { files: 0, additions: 0, deletions: 0, critical: false };
    for (const u of units) {
      const s = own(u);
      stats.set(u.id, s);
      total.files += s.files;
      total.additions += s.additions;
      total.deletions += s.deletions;
      total.critical ||= s.critical;
    }
    if (chapter) stats.set(chapter.id, total);
  }

  const ordered = chapters.flatMap(({ chapter, units }) => (chapter ? [chapter, ...units] : units));
  return { chapters, stats, byId, ordered };
}

/** A chapter is a top-level group that holds no files itself or has units under it. */
export function isChapter(g: RunGroup, groups: readonly RunGroup[]): boolean {
  if (g.parentId !== undefined) return false;
  return g.files.length === 0 || groups.some((c) => c.parentId === g.id);
}
