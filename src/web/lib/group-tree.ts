import type { GuideStop, RunFile, RunFinding, RunGroup } from "../../types/review-run.ts";
import { plural } from "./format.ts";

export interface GroupStats {
  files: number;
  additions: number;
  deletions: number;
  /** How many of `files` are binary. */
  binary: number;
  /** The group or any of its units is marked critical. */
  critical: boolean;
  /** Why it is critical, e.g. "1 blocker, 2 should-fix findings". */
  criticalReason?: string;
}

export interface GroupNotes {
  findings: readonly Pick<RunFinding, "id" | "severity">[];
  stops: readonly Pick<GuideStop, "id" | "importance">[];
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
export function buildGroupTree(
  groups: readonly RunGroup[],
  files: readonly RunFile[],
  notes: GroupNotes = { findings: [], stops: [] },
): GroupTree {
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
    const s: GroupStats = { files: 0, additions: 0, deletions: 0, binary: 0, critical: g.critical };
    for (const p of g.files) {
      const f = fileByPath.get(p);
      s.files += 1;
      s.additions += f?.additions ?? 0;
      s.deletions += f?.deletions ?? 0;
      if (f?.isBinary) s.binary += 1;
    }
    return s;
  };
  for (const { chapter, units } of chapters) {
    const total: GroupStats = chapter
      ? own(chapter)
      : { files: 0, additions: 0, deletions: 0, binary: 0, critical: false };
    for (const u of units) {
      const s = own(u);
      stats.set(u.id, s);
      total.files += s.files;
      total.additions += s.additions;
      total.deletions += s.deletions;
      total.binary += s.binary;
      total.critical ||= s.critical;
    }
    if (chapter) stats.set(chapter.id, total);
  }

  const reasonOf = criticalReasons(notes);
  for (const { chapter, units } of chapters) {
    for (const u of units) setReason(stats.get(u.id), reasonOf([u]));
    if (chapter) setReason(stats.get(chapter.id), reasonOf([chapter, ...units]));
  }

  const ordered = chapters.flatMap(({ chapter, units }) => (chapter ? [chapter, ...units] : units));
  return { chapters, stats, byId, ordered };
}

function setReason(stats: GroupStats | undefined, reason: string | undefined): void {
  if (stats?.critical && reason) stats.criticalReason = reason;
}

const SEVERITY_ORDER = ["blocker", "should-fix"] as const;

/** Mirrors `isCritical` in build-run.ts: blocker or should-fix findings, or critical guide stops. */
function criticalReasons({ findings, stops }: GroupNotes) {
  const severityOf = new Map(findings.map((f) => [f.id, f.severity]));
  const criticalStops = new Set(stops.filter((s) => s.importance === "critical").map((s) => s.id));
  return (groups: readonly RunGroup[]): string | undefined => {
    const findingIds = new Set(groups.flatMap((g) => g.findingIds));
    const stopIds = new Set(groups.flatMap((g) => g.stopIds));
    const counts = SEVERITY_ORDER.map((sev) => ({
      sev,
      n: [...findingIds].filter((id) => severityOf.get(id) === sev).length,
    })).filter((c) => c.n > 0);
    const parts: string[] = [];
    if (counts.length) {
      const total = counts.reduce((sum, c) => sum + c.n, 0);
      parts.push(`${counts.map((c) => `${c.n} ${c.sev}`).join(", ")} ${total === 1 ? "finding" : "findings"}`);
    }
    const stopCount = [...stopIds].filter((id) => criticalStops.has(id)).length;
    if (stopCount) parts.push(plural(stopCount, "critical walkthrough stop"));
    return parts.length ? parts.join("; ") : undefined;
  };
}

/** A chapter is a top-level group that holds no files itself or has units under it. */
export function isChapter(g: RunGroup, groups: readonly RunGroup[]): boolean {
  if (g.parentId !== undefined) return false;
  return g.files.length === 0 || groups.some((c) => c.parentId === g.id);
}
