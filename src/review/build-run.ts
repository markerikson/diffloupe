/**
 * Turns the review core's output and the run's patch into a `ReviewRun`.
 * Pure: no git, no file system. Imports `@pierre/diffs`, whose root entry is
 * slow to load, so callers on the CLI path import this module lazily.
 */
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type {
  DiffAnchor,
  FindingSeverity,
  GroupIcon,
  GuideStop,
  ReviewRun,
  ReviewTarget,
  RunFile,
  RunFileStatus,
  RunFinding,
  RunGroup,
  RunSlice,
} from "../types/review-run.ts";
import { anchor } from "./anchors.ts";
import { classifyFile, type Finding } from "./core/findings.ts";
import { fingerprint } from "./core/lib/marker.ts";
import { classifySurface } from "./core/surface.ts";
import type { RunReviewResult } from "./core/pipeline.ts";
import type { ReviewUnit, Walkthrough } from "./core/prompts.ts";
import { fingerprintOf, mapLine, type LineHunk } from "./prior-run.ts";

/** The parts of the core's run record this module reads. */
interface CoreRecord {
  model?: string;
  effort?: string;
  wallMs?: number;
  totalCostUsd?: number;
  mergeMode?: string;
  sliceRuns?: {
    unit: string;
    part: number;
    parts: number;
    ok: boolean;
    costUsd?: number;
    wallMs?: number;
  }[];
  walkthrough?: Walkthrough | null;
  verifiedFindings?: Finding[];
  overCapFindings?: Finding[];
  unreviewed?: { overCap: string[]; failed: string[]; budget?: string[] };
  budgetStopped?: boolean;
  resolved?: { id: number; note?: string }[];
  rejected?: unknown[];
  intentAlignment?: {
    summary?: string;
    unstated?: string[];
    missing?: string[];
  } | null;
}

export interface BuildReviewRunInput {
  id: string;
  createdAt: string;
  repo: { root: string; slug?: string };
  target: ReviewTarget;
  base: string;
  head: string;
  statedIntent?: string;
  patch: string;
  result: Pick<RunReviewResult, "record" | "units" | "byClass" | "costUsd" | "wallMs">;
  untrackedSkipped?: string[];
  coreSource: string;
  priorRunId?: string;
  /** The model each stage was resolved to before the run started. */
  models?: NonNullable<ReviewRun["meta"]["models"]>;
  /**
   * The earlier run of this target whose findings were handed to the review as
   * prior comments. `lineMap` holds `git diff -U0 <its head> <this head>` hunks,
   * used to move a carried finding's line to where that code now sits.
   */
  previous?: { run: ReviewRun; dismissed?: string[]; lineMap?: Map<string, LineHunk[]> };
  /** Receives one line per structural problem worth knowing about. Defaults to stderr. */
  log?: (message: string) => void;
}

const ICONS = new Set<GroupIcon>(["bug", "wrench", "path", "flask", "doc", "gear"]);
const MERGE_MODES = new Set(["coordinator", "nothing-to-merge", "deterministic-fallback"]);
const BLOCKING = new Set<FindingSeverity>(["blocker", "should-fix"]);

const STATUS: Record<FileDiffMetadata["type"], RunFileStatus> = {
  new: "added",
  deleted: "removed",
  change: "modified",
  "rename-pure": "renamed",
  "rename-changed": "renamed",
};

/** Paths git reported as binary, keyed by the head-side path (base side for a deletion). */
function binaryPaths(patch: string): Set<string> {
  const out = new Set<string>();
  for (const m of patch.matchAll(/^Binary files (?:a\/(.+?)|\/dev\/null) and (?:b\/(.+?)|\/dev\/null) differ$/gm)) {
    const p = m[2] ?? m[1];
    if (p) out.add(p);
  }
  return out;
}

export function parseRunPatch(patch: string): FileDiffMetadata[] {
  return parsePatchFiles(patch).flatMap((p) => p.files);
}

function toRunFiles(parsed: FileDiffMetadata[], patch: string, byClass: RunReviewResult["byClass"]): RunFile[] {
  const binary = binaryPaths(patch);
  const cls = new Map<string, RunFile["classification"]>();
  for (const k of ["skip", "docs", "code"] as const) for (const f of byClass[k]) cls.set(f, k);
  return parsed.map((f) => {
    let additions = 0;
    let deletions = 0;
    for (const h of f.hunks) {
      additions += h.additionLines;
      deletions += h.deletionLines;
    }
    return {
      path: f.name,
      ...(f.prevName && f.prevName !== f.name ? { previousPath: f.prevName } : {}),
      status: STATUS[f.type],
      additions,
      deletions,
      isBinary: binary.has(f.name),
      ...(f.newObjectId ? { blob: f.newObjectId } : {}),
      groupId: "",
      classification: cls.get(f.name) ?? classifyFile(f.name),
      surface: classifySurface(f.name),
    };
  });
}

function parseRef(ref: string): { file: string; line?: number } {
  const m = ref.match(/^(.+?):(\d+)(?:-\d+)?$/);
  return m?.[1] && m[2] ? { file: m[1], line: Number(m[2]) } : { file: ref };
}

function toRunFinding(f: Finding, id: string, file: FileDiffMetadata | undefined): RunFinding {
  return {
    id,
    file: f.file,
    anchor: anchor(file, f.file, f.line, f.end_line),
    severity: f.severity,
    category: f.category,
    title: f.title,
    explanation: f.explanation,
    evidence: f.evidence,
    ...(f.impact ? { impact: f.impact } : {}),
    confidence: f.confidence,
    ...(f.effort ? { effort: f.effort } : {}),
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    ...(f.suggested_code ? { suggestedCode: f.suggested_code } : {}),
    ...(f.cross_file_refs?.length ? { crossFileRefs: f.cross_file_refs.map(parseRef) } : {}),
    ...(f.repeat_of !== undefined ? { repeatOf: f.repeat_of } : {}),
    surface: classifySurface(f.file),
  };
}

function uniq(items: string[]): string[] {
  return [...new Set(items)];
}

function sharedDirDepth(a: string, b: string): number {
  const da = a.split("/").slice(0, -1);
  const db = b.split("/").slice(0, -1);
  let n = 0;
  while (n < da.length && n < db.length && da[n] === db[n]) n++;
  return n;
}

interface UnitLeaf {
  id: string;
  unit: ReviewUnit;
  files: string[];
  chapter?: number;
}

/**
 * The walkthrough often spreads one review unit over several chapters, so
 * chapters are assigned per file: a file joins the chapter of the first stop
 * that cites it. An uncited test file follows the file it tests (same path,
 * then same file name). Any other uncited file follows the cited
 * file in its unit sharing the deepest directory, then the chapter holding
 * most of its unit's cited files. A unit spanning chapters becomes one leaf
 * per chapter.
 */
function splitByChapter(leaves: UnitLeaf[], stops: GuideStop[]): UnitLeaf[] {
  const chapterOfFile = new Map<string, number>();
  for (const s of stops) {
    const ci = Number(s.chapterId.slice(1)) - 1;
    for (const l of s.locations) if (!chapterOfFile.has(l.file)) chapterOfFile.set(l.file, ci);
  }
  return leaves.flatMap((leaf) => {
    const cited = leaf.files.flatMap((f) => {
      const ci = chapterOfFile.get(f);
      return ci === undefined ? [] : [{ file: f, ci }];
    });
    if (!cited.length) return [leaf];
    const counts = new Map<number, number>();
    for (const { ci } of cited) counts.set(ci, (counts.get(ci) ?? 0) + 1);
    let home = 0;
    let homeCount = 0;
    for (const [ci, n] of counts) {
      if (n > homeCount || (n === homeCount && ci < home)) {
        home = ci;
        homeCount = n;
      }
    }
    const place = (f: string) => {
      const subject = f.replace(/\.(test|spec)(\.[^./]+)$/, "$2");
      const direct = chapterOfFile.get(f) ?? chapterOfFile.get(subject);
      if (direct !== undefined) return direct;
      if (subject !== f) {
        const name = subject.slice(subject.lastIndexOf("/") + 1);
        const twin = [...chapterOfFile].find(([c]) => c.endsWith(`/${name}`) || c === name);
        if (twin) return twin[1];
      }
      let best: { depth: number; ci: number } | undefined;
      for (const c of cited) {
        const depth = sharedDirDepth(f, c.file);
        if (depth > 0 && (!best || depth > best.depth || (depth === best.depth && c.ci < best.ci)))
          best = { depth, ci: c.ci };
      }
      return best?.ci ?? home;
    };
    const byChapter = new Map<number, string[]>();
    for (const f of leaf.files) {
      const ci = place(f);
      byChapter.set(ci, [...(byChapter.get(ci) ?? []), f]);
    }
    const split = byChapter.size > 1;
    return [...byChapter]
      .sort((a, b) => a[0] - b[0])
      .map(([ci, files]) => ({ id: split ? `${leaf.id}-c${ci + 1}` : leaf.id, unit: leaf.unit, files, chapter: ci }));
  });
}

/**
 * The review was told not to repeat the prior run's findings, so a finding it
 * neither re-reported nor marked fixed is still open and is carried into this
 * run. Without a prior run, `resolved` ids are comment ids and pass through.
 */
function carryForward(
  input: BuildReviewRunInput,
  recordResolved: { id: number; note?: string }[],
  current: RunFinding[],
  byPath: Map<string, FileDiffMetadata>,
  log: (message: string) => void,
): { carried: RunFinding[]; resolved: ReviewRun["resolved"] } {
  const prev = input.previous;
  if (!prev) {
    return {
      carried: [],
      resolved: recordResolved.map((r) => ({ id: String(r.id), ...(r.note ? { note: r.note } : {}) })),
    };
  }
  const prevFindings = prev.run.findings;
  const resolved: ReviewRun["resolved"] = [];
  const fixed = new Set<string>();
  for (const r of recordResolved) {
    const f = prevFindings[r.id - 1];
    if (!f) continue;
    fixed.add(f.id);
    resolved.push({ id: f.id, title: f.title, file: f.file, ...(r.note ? { note: r.note } : {}) });
  }
  const origin = new Map(prevFindings.map((f) => [fingerprintOf(f.id), f.carriedFrom ?? prev.run.id]));
  for (const f of current) {
    const from = origin.get(fingerprintOf(f.id));
    if (from) f.carriedFrom = from;
  }
  const reported = new Set(current.map((f) => fingerprintOf(f.id)));
  const dismissed = new Set(prev.dismissed ?? []);
  const carried: RunFinding[] = [];
  for (const f of prevFindings) {
    if (fixed.has(f.id) || dismissed.has(f.id) || reported.has(fingerprintOf(f.id))) continue;
    const file = byPath.get(f.file);
    if (!file) {
      log(`  prior finding "${f.title}" dropped: ${f.file} is no longer in the diff`);
      continue;
    }
    const hunks = prev.lineMap?.get(f.file) ?? [];
    const move = (line: number | undefined) => (line ? mapLine(hunks, line) : undefined);
    carried.push({
      ...f,
      anchor: anchor(file, f.file, move(f.anchor.cited.line), move(f.anchor.cited.endLine)),
      carriedFrom: f.carriedFrom ?? prev.run.id,
    });
  }
  return { carried, resolved };
}

export function buildReviewRun(input: BuildReviewRunInput): ReviewRun {
  const log = input.log ?? ((m: string) => console.error(m));
  const record = input.result.record as CoreRecord | null;
  const walkthrough = record?.walkthrough ?? null;

  const parsed = parseRunPatch(input.patch);
  const byPath = new Map(parsed.map((f) => [f.name, f]));
  const files = toRunFiles(parsed, input.patch, input.result.byClass);
  const fileByPath = new Map(files.map((f) => [f.path, f]));

  // ---- findings
  const usedIds = new Map<string, number>();
  const findingId = (f: Finding) => {
    const base = fingerprint(f.file, f.title);
    const n = (usedIds.get(base) ?? 0) + 1;
    usedIds.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
  const findings = (record?.verifiedFindings ?? []).map((f) => toRunFinding(f, findingId(f), byPath.get(f.file)));
  const overCapFindings = (record?.overCapFindings ?? []).map((f) => toRunFinding(f, findingId(f), byPath.get(f.file)));
  const { carried, resolved } = carryForward(input, record?.resolved ?? [], [...findings, ...overCapFindings], byPath, log);
  findings.push(...carried);

  // ---- walkthrough stops
  const isDirectory = (p: string) => {
    const dir = p.endsWith("/") ? p : `${p}/`;
    return !byPath.has(p) && parsed.some((f) => f.name.startsWith(dir));
  };
  const stops: GuideStop[] = [];
  const chapters = walkthrough?.chapters ?? [];
  chapters.forEach((ch, ci) => {
    (ch.stops ?? []).forEach((st, si) => {
      const locations: GuideStop["locations"] = [];
      for (const loc of st.locations ?? []) {
        if (isDirectory(loc.file)) {
          log(`  walkthrough: dropped directory location ${loc.file} in "${st.title}"`);
          continue;
        }
        const a: DiffAnchor = anchor(byPath.get(loc.file), loc.file, loc.line, undefined, { deletionsFallback: true });
        locations.push({ ...a, ...(loc.label ? { label: loc.label } : {}) });
      }
      stops.push({
        id: `c${ci + 1}-s${si + 1}`,
        chapterId: `c${ci + 1}`,
        index: si,
        title: st.title,
        ...(st.prose ? { prose: st.prose } : {}),
        importance: st.importance ?? "normal",
        locations,
      });
    });
  });

  // ---- leaf groups from units, each file in exactly one group
  const assigned = new Set<string>();
  const take = (paths: string[]) => {
    const out: string[] = [];
    for (const p of paths) {
      if (!fileByPath.has(p)) continue;
      if (assigned.has(p)) continue;
      assigned.add(p);
      out.push(p);
    }
    return out;
  };

  const startHere = new Set((walkthrough?.start_here ?? []).map((s) => s.file));
  const unitOrder = [...input.result.units].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  const unitIds = new Set<string>();
  const leafFor = (unit: ReviewUnit) => {
    let id = `u-${unit.id}`;
    for (let n = 2; unitIds.has(id); n++) id = `u-${unit.id}-${n}`;
    unitIds.add(id);
    const missing = unit.files.filter((p) => !fileByPath.has(p));
    if (missing.length)
      log(`  unit "${unit.title}": ${missing.length} file(s) not in the patch: ${missing.join(", ")}`);
    return { id, unit, files: take(unit.files) };
  };
  const unitLeaves = splitByChapter(unitOrder.map(leafFor).filter((l) => l.files.length), stops);
  const chapterOf = new Map(unitLeaves.flatMap((l) => (l.chapter === undefined ? [] : [[l.id, l.chapter] as const])));

  const groups: RunGroup[] = [];
  const leaf = (id: string, title: string, paths: string[], extra: Partial<RunGroup> = {}): RunGroup => ({
    id,
    title,
    files: paths,
    findingIds: [],
    stopIds: [],
    critical: false,
    ...extra,
  });
  const parent = (id: string, title: string, extra: Partial<RunGroup> = {}): RunGroup => leaf(id, title, [], extra);
  const unitGroup = (l: (typeof unitLeaves)[number], parentId?: string) =>
    leaf(l.id, l.unit.title, l.files, {
      ...(parentId ? { parentId } : {}),
      ...(l.unit.rationale ? { summary: l.unit.rationale } : {}),
    });
  const startsHere = (l: (typeof unitLeaves)[number]) => l.files.some((f) => startHere.has(f));

  if (chapters.length) {
    chapters.forEach((ch, ci) => {
      const id = `c${ci + 1}`;
      const icon = ch.icon as GroupIcon | undefined;
      groups.push(
        parent(id, ch.title, {
          ...(ch.blurb ? { summary: ch.blurb } : {}),
          ...(icon && ICONS.has(icon) ? { icon } : {}),
          stopIds: stops.filter((s) => s.chapterId === id).map((s) => s.id),
        }),
      );
      const mine = unitLeaves.filter((l) => chapterOf.get(l.id) === ci);
      const ordered = [...mine.filter(startsHere), ...mine.filter((l) => !startsHere(l))];
      for (const l of ordered) groups.push(unitGroup(l, id));
    });
    const loose = unitLeaves.filter((l) => !chapterOf.has(l.id));
    if (loose.length) {
      const reasons = uniq((walkthrough?.support ?? []).map((s) => s.reason).filter(Boolean));
      groups.push(parent("supporting", "Supporting changes", reasons.length ? { summary: reasons.join(" ") } : {}));
      for (const l of loose) groups.push(unitGroup(l, "supporting"));
    }
  } else {
    for (const l of unitLeaves) groups.push(unitGroup(l));
  }

  // ---- trailing section: docs, generated, and anything no unit claimed
  const docs = take(files.filter((f) => f.classification === "docs").map((f) => f.path));
  const skipped = take(files.filter((f) => f.classification === "skip").map((f) => f.path));
  const strays = take(files.map((f) => f.path));
  if (strays.length) log(`  ${strays.length} file(s) in no review unit: ${strays.join(", ")}`);
  if (docs.length || skipped.length || strays.length) {
    groups.push(parent("other", "Not reviewed in depth"));
    if (strays.length) groups.push(leaf("remaining", "Remaining changes", strays, { parentId: "other" }));
    if (docs.length) groups.push(leaf("docs", "Docs", docs, { parentId: "other", icon: "doc" }));
    if (skipped.length)
      groups.push(
        leaf("skipped", "Generated and skipped", skipped, {
          parentId: "other",
          icon: "gear",
        }),
      );
  }

  // ---- wire files, findings and stops onto groups
  const groupOfFile = new Map<string, RunGroup>();
  for (const g of groups) for (const p of g.files) groupOfFile.set(p, g);
  for (const f of files) f.groupId = groupOfFile.get(f.path)?.id ?? "";

  const stopById = new Map(stops.map((s) => [s.id, s]));
  for (const g of groups) {
    if (!g.files.length) continue;
    const set = new Set(g.files);
    g.findingIds = findings.filter((f) => set.has(f.file)).map((f) => f.id);
    g.stopIds = stops.filter((s) => s.locations.some((l) => set.has(l.file))).map((s) => s.id);
  }
  const severityOf = new Map(findings.map((f) => [f.id, f.severity]));
  const isCritical = (g: RunGroup) =>
    g.findingIds.some((id) => BLOCKING.has(severityOf.get(id) ?? "question")) ||
    g.stopIds.some((id) => stopById.get(id)?.importance === "critical");
  for (const g of groups) if (g.files.length) g.critical = isCritical(g);
  for (const g of groups) {
    if (g.files.length) continue;
    const children = groups.filter((c) => c.parentId === g.id);
    g.findingIds = uniq(children.flatMap((c) => c.findingIds));
    g.critical = children.some((c) => c.critical) || isCritical(g);
  }
  const homeless = findings.filter((f) => !groupOfFile.has(f.file));
  if (homeless.length) log(`  ${homeless.length} finding(s) name files outside the patch`);

  // ---- intent and overview
  const wi = walkthrough?.intent;
  const ia = record?.intentAlignment ?? undefined;
  const unstated = uniq([...(wi?.unstated ?? []), ...(ia?.unstated ?? [])]);
  const missing = uniq([...(wi?.missing ?? []), ...(ia?.missing ?? [])]);
  const mismatches = uniq([...(ia?.summary ? [ia.summary] : []), ...(wi?.mismatches ?? [])]);
  // Same rule as the markdown render: a coordinator divergence sentence
  // downgrades an "aligned" verdict, since the two calls never see each other.
  const alignment = wi?.alignment === "aligned" && ia?.summary ? "partial" : wi?.alignment;
  const intent: ReviewRun["intent"] = {
    ...(input.statedIntent ? { stated: input.statedIntent } : {}),
    ...(wi?.inferred ? { inferred: wi.inferred } : {}),
    ...(alignment ? { alignment } : {}),
    ...(wi?.matches?.length ? { matches: wi.matches } : {}),
    ...(mismatches.length ? { mismatches } : {}),
    ...(unstated.length ? { unstated } : {}),
    ...(missing.length ? { missing } : {}),
  };

  const slices: RunSlice[] = (record?.sliceRuns ?? []).map((s) => ({
    unit: s.unit,
    part: s.part,
    parts: s.parts,
    status: s.ok ? "ok" : "failed",
    costUsd: s.costUsd ?? 0,
    wallMs: s.wallMs ?? 0,
  }));
  const mergeMode = record?.mergeMode;

  return {
    schemaVersion: 1,
    id: input.id,
    status: "complete",
    createdAt: input.createdAt,
    repo: input.repo,
    target: input.target,
    base: input.base,
    head: input.head,
    intent,
    overview: {
      ...(walkthrough?.focus ? { focus: walkthrough.focus } : {}),
      ...(walkthrough?.change_type ? { changeType: walkthrough.change_type } : {}),
      startHere: walkthrough?.start_here ?? [],
    },
    files,
    groups,
    stops,
    findings,
    overCapFindings,
    resolved,
    unreviewed: record?.unreviewed ?? { overCap: [], failed: [] },
    meta: {
      ...(record?.model ? { model: record.model } : {}),
      ...(record?.effort ? { effort: record.effort } : {}),
      ...(input.models ? { models: input.models } : {}),
      wallMs: record?.wallMs ?? input.result.wallMs,
      costUsd: record?.totalCostUsd ?? input.result.costUsd,
      slices,
      rejectedCount: record?.rejected?.length ?? 0,
      coreSource: input.coreSource,
      ...(mergeMode && MERGE_MODES.has(mergeMode)
        ? {
            mergeMode: mergeMode as NonNullable<ReviewRun["meta"]["mergeMode"]>,
          }
        : {}),
      ...(record?.budgetStopped ? { budgetStopped: true } : {}),
    },
    untrackedSkipped: input.untrackedSkipped ?? [],
    ...(input.priorRunId ? { priorRunId: input.priorRunId } : {}),
  };
}

export type BuildPendingRunInput = Pick<
  BuildReviewRunInput,
  | "id"
  | "createdAt"
  | "repo"
  | "target"
  | "base"
  | "head"
  | "statedIntent"
  | "patch"
  | "untrackedSkipped"
  | "priorRunId"
  | "coreSource"
  | "models"
>;

/**
 * The run as it stands before the review returns: every file from the patch
 * in one group, nothing else. Written when a run starts so the UI has a file
 * list to show, and replaced by `buildReviewRun`'s output at the end.
 */
/**
 * The running run once the core has formed its review units: the groups
 * `buildReviewRun` would make from them without a walkthrough, and no findings.
 */
export function buildGroupedPendingRun(
  input: BuildPendingRunInput,
  units: ReviewUnit[],
  byClass: RunReviewResult["byClass"],
): ReviewRun {
  const run = buildReviewRun({
    ...input,
    result: { record: null, units, byClass, costUsd: 0, wallMs: 0 },
    log: () => {},
  });
  return { ...run, status: "running" };
}

export function buildPendingRun(input: BuildPendingRunInput): ReviewRun {
  const files = toRunFiles(parseRunPatch(input.patch), input.patch, { skip: [], docs: [], code: [] });
  for (const f of files) f.groupId = "all";
  return {
    schemaVersion: 1,
    id: input.id,
    status: "running",
    createdAt: input.createdAt,
    repo: input.repo,
    target: input.target,
    base: input.base,
    head: input.head,
    intent: input.statedIntent ? { stated: input.statedIntent } : {},
    overview: { startHere: [] },
    files,
    groups: [
      {
        id: "all",
        title: "All changes",
        files: files.map((f) => f.path),
        findingIds: [],
        stopIds: [],
        critical: false,
      },
    ],
    stops: [],
    findings: [],
    overCapFindings: [],
    resolved: [],
    unreviewed: { overCap: [], failed: [] },
    meta: {
      ...(input.models ? { models: input.models } : {}),
      wallMs: 0,
      costUsd: 0,
      slices: [],
      rejectedCount: 0,
      coreSource: input.coreSource,
    },
    untrackedSkipped: input.untrackedSkipped ?? [],
    ...(input.priorRunId ? { priorRunId: input.priorRunId } : {}),
  };
}
