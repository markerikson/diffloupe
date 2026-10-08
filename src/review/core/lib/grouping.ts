/**
 * Groups changed files into review units from the code itself.
 *
 * The model-written partition decided which files a reviewer sees together, and
 * on #13157 it put `caches/react.ts` and `reactPhases.ts` in different units.
 * The first calls `cx.reactPhases.getLastCurrentTreePointBeforeOrEquals`, which
 * the second adds in the same pull request, and the only defect in that pair
 * was a mismatch between the two. Neither imports the other — the call goes
 * through the analysis context — so an import graph would have split them too.
 * The link that holds them together is a name used on added lines of one file
 * and defined on added lines of the other. That is computable, so grouping is
 * computed and the model is only asked to name the result.
 *
 * Links between changed files, strongest first:
 *   - symbol: a name used on added lines of one file is defined on added lines
 *     of another. Two files changed so that they agree with each other.
 *   - pair: a test and the file it covers, or a C++ header and its source.
 *   - import: one changed file imports another.
 *   - dir: same directory. Only used to fold small leftovers together.
 *
 * A link that could not be honored because of the size limits is kept as a
 * cut, and both reviewers are told about it, so a split is never silent.
 */

export type LinkKind = "symbol" | "pair" | "import" | "dir";

export interface FileFacts {
  file: string;
  tokens: number;
  /** Repo-relative paths this file imports, at the head commit. */
  imports: string[];
  /** Names whose definition starts on an added line. */
  defined: string[];
  /** Identifiers appearing on added lines. */
  used: string[];
}

export interface Link {
  /** The file that uses or imports. For `pair` and `dir`, path order. */
  from: string;
  to: string;
  kind: LinkKind;
  weight: number;
  /** For `symbol` links: the shared names, most specific first. */
  names?: string[];
}

export interface CodeGroup {
  id: string;
  files: string[];
  tokens: number;
  /** Links inside the group, strongest first. */
  links: Link[];
}

export interface CodeGrouping {
  groups: CodeGroup[];
  /** Links whose two ends ended up in different groups, strongest first. */
  cut: Link[];
}

export interface GroupingOptions {
  /** Token budget per group. A single file larger than this is its own group. */
  budget: number;
  /** Merging stops at this many tokens; only rehoming fills a group up to `budget`. */
  target?: number;
  /** Symbol, pair and import links never build a group with more files than this. */
  maxFiles?: number;
  /** Past this many groups, the smallest are merged into their closest neighbors. */
  maxGroups?: number;
  /** A directory link never builds a group with more files than this. */
  maxDirFiles?: number;
  /** Names too common to say anything about which files belong together. */
  generic?: Set<string>;
}

const TEST_FILE = /\.(test|spec)(\.[cm]?[jt]sx?)$/;
const CPP_HEADER = /\.(h|hh|hpp)$/;
const CPP_SOURCE = /\.(c|cc|cpp|cxx)$/;

function dirOf(f: string): string {
  const i = f.lastIndexOf("/");
  return i < 0 ? "" : f.slice(0, i);
}

function stem(f: string): string {
  const base = f.slice(f.lastIndexOf("/") + 1);
  return base.replace(TEST_FILE, "").replace(/\.[^.]+$/, "");
}

/**
 * A name somebody coined rather than an English word they reused. Same test the
 * repo map applies: a capital or an underscore, and long enough not to be a
 * common abbreviation.
 */
export function isDistinctiveName(name: string, generic: Set<string> = new Set()): boolean {
  if (name.length < 6) return false;
  if (generic.has(name) || generic.has(name.toLowerCase())) return false;
  return /[A-Z_]/.test(name);
}

/**
 * Pairs a file with the one it is obviously about: `foo.test.ts` with `foo.ts`
 * in the same directory or one directory up (a `test/` or `__tests__/` folder),
 * and a C++ header with its source.
 */
function pairedWith(a: string, b: string): boolean {
  if (stem(a) !== stem(b)) return false;
  const [da, db] = [dirOf(a), dirOf(b)];
  const near = da === db || dirOf(da) === db || dirOf(db) === da;
  if (!near) return false;
  if (TEST_FILE.test(a) !== TEST_FILE.test(b)) return true;
  return (CPP_HEADER.test(a) && CPP_SOURCE.test(b)) || (CPP_HEADER.test(b) && CPP_SOURCE.test(a));
}

/**
 * Every link between two changed files, merged so each unordered pair appears
 * once, under its strongest kind, with the weights of all its kinds summed.
 *
 * Weights are divided by how widely a name or file is shared. A type defined in
 * one file and used by twenty others links all of them, and if every one of
 * those links counted fully the type's file would pull the whole pull request
 * into one group. Dividing by the number of users keeps a hub's links real but
 * weak, so it is grouped with its closest partners and cut from the rest.
 */
export function linkFiles(facts: FileFacts[], generic: Set<string> = new Set()): Link[] {
  const files = new Set(facts.map((f) => f.file));
  const definers = new Map<string, string[]>();
  for (const f of facts) {
    for (const name of new Set(f.defined)) {
      if (!isDistinctiveName(name, generic)) continue;
      const list = definers.get(name) ?? [];
      list.push(f.file);
      definers.set(name, list);
    }
  }
  const usersOf = new Map<string, number>();
  for (const f of facts) {
    for (const name of new Set(f.used)) {
      if (definers.has(name)) usersOf.set(name, (usersOf.get(name) ?? 0) + 1);
    }
  }
  const importers = new Map<string, number>();
  for (const f of facts) {
    for (const imp of new Set(f.imports)) {
      if (files.has(imp) && imp !== f.file) importers.set(imp, (importers.get(imp) ?? 0) + 1);
    }
  }

  const KIND_RANK: Record<LinkKind, number> = { symbol: 0, pair: 1, import: 2, dir: 3 };
  const byPair = new Map<string, Link>();
  const add = (from: string, to: string, kind: LinkKind, weight: number, name?: string) => {
    if (from === to) return;
    const key = from < to ? `${from}\0${to}` : `${to}\0${from}`;
    const cur = byPair.get(key);
    if (!cur) {
      byPair.set(key, { from, to, kind, weight, ...(name ? { names: [name] } : {}) });
      return;
    }
    cur.weight += weight;
    if (KIND_RANK[kind] < KIND_RANK[cur.kind]) {
      cur.kind = kind;
      cur.from = from;
      cur.to = to;
    }
    if (name && !cur.names?.includes(name)) cur.names = [...(cur.names ?? []), name];
  };

  for (const f of facts) {
    for (const name of new Set(f.used)) {
      const defs = definers.get(name);
      // A name three files define is not a link between any two of them, and a
      // file using a name it defines itself is using its own.
      if (!defs || defs.length > 2 || defs.includes(f.file)) continue;
      const users = usersOf.get(name) ?? 1;
      for (const d of defs) add(f.file, d, "symbol", 4 / users, name);
    }
    for (const imp of new Set(f.imports)) {
      if (!files.has(imp)) continue;
      add(f.file, imp, "import", 2 / Math.max(1, (importers.get(imp) ?? 1) - 1));
    }
  }
  const sorted = [...files].sort();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const [a, b] = [sorted[i], sorted[j]];
      if (pairedWith(a, b)) add(a, b, "pair", 3);
      else if (dirOf(a) === dirOf(b)) add(a, b, "dir", 0.25);
    }
  }
  return sortLinks([...byPair.values()]);
}

function sortLinks(links: Link[]): Link[] {
  return links.sort(
    (x, y) => y.weight - x.weight || x.from.localeCompare(y.from) || x.to.localeCompare(y.to),
  );
}

function commonDir(files: string[]): string {
  if (!files.length) return "";
  let parts = dirOf(files[0]).split("/");
  for (const f of files.slice(1)) {
    const other = dirOf(f).split("/");
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.filter(Boolean).join("/");
}

function slug(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * A placeholder id until the namer picks a title: the last two directories the
 * files share, or, when they share less than that, the largest file's name.
 */
function groupSlug(files: string[], tokens: Map<string, number>): string {
  const dirs = commonDir(files).split("/").filter(Boolean);
  if (files.length > 1 && dirs.length >= 3) return slug(dirs.slice(-2).join("-"));
  const largest = [...files].sort((a, b) => (tokens.get(b) ?? 0) - (tokens.get(a) ?? 0))[0];
  return slug(stem(largest)) || "files";
}

/** How many leading directory segments two paths share. */
function sharedDepth(a: string, b: string): number {
  const [pa, pb] = [a.split("/"), b.split("/")];
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
  return i;
}

const STRONG: ReadonlySet<LinkKind> = new Set(["symbol", "pair"]);

/**
 * Builds groups in passes by link kind — symbol and pair links first, then
 * imports, then directories — so a weak link processed early can never use up
 * the room a stronger one needed. Within a pass, heavier links go first.
 *
 * Two limits bound a group: the token budget, and a file count. Without the
 * file count a small pull request becomes one group however unrelated its
 * parts are, because nothing but the budget would stop the merging.
 *
 * Greedy merging cannot move a file once it is placed. A last pass does that
 * for symbol and pair links: a file whose strongest such links point into
 * another group moves there when it fits.
 */
export function groupFiles(facts: FileFacts[], links: Link[], opts: GroupingOptions): CodeGrouping {
  const maxFiles = opts.maxFiles ?? 8;
  const maxDirFiles = opts.maxDirFiles ?? 6;
  const tokens = new Map(facts.map((f) => [f.file, f.tokens]));
  const groupOf = new Map(facts.map((f, i) => [f.file, i]));
  const filesIn = new Map(facts.map((f, i) => [i, new Set([f.file])]));
  const size = new Map(facts.map((f, i) => [i, f.tokens]));

  const merge = (a: number, b: number) => {
    const [keep, gone] = filesIn.get(a)!.size >= filesIn.get(b)!.size ? [a, b] : [b, a];
    for (const f of filesIn.get(gone)!) {
      groupOf.set(f, keep);
      filesIn.get(keep)!.add(f);
    }
    size.set(keep, size.get(keep)! + size.get(gone)!);
    filesIn.delete(gone);
    size.delete(gone);
  };
  // Merging stops short of the budget so the rehoming pass has room to move a
  // file into a group after it is built.
  const target = opts.target ?? Math.round(opts.budget * 0.7);
  const fits = (a: number, b: number, fileCap: number) =>
    size.get(a)! + size.get(b)! <= target &&
    filesIn.get(a)!.size + filesIn.get(b)!.size <= fileCap;

  const passes: Array<[(l: Link) => boolean, number]> = [
    [(l) => STRONG.has(l.kind), maxFiles],
    [(l) => l.kind === "import", maxFiles],
    [(l) => l.kind === "dir", maxDirFiles],
  ];
  for (const [inPass, fileCap] of passes) {
    for (const l of links) {
      if (!inPass(l)) continue;
      const [ga, gb] = [groupOf.get(l.from), groupOf.get(l.to)];
      if (ga === undefined || gb === undefined || ga === gb || !fits(ga, gb, fileCap)) continue;
      merge(ga, gb);
    }
  }

  // Leftovers that share no link with anything still need a reviewer, and one
  // slice per stray config file is expensive. Fold each small group into the
  // nearest group by directory that has room, smallest first.
  const small = target / 4;
  const bySize = () => [...filesIn.keys()].sort((a, b) => size.get(a)! - size.get(b)! || a - b);
  for (const g of bySize()) {
    if (!filesIn.has(g) || size.get(g)! > small || filesIn.get(g)!.size > 2) continue;
    let best: { group: number; depth: number } | undefined;
    for (const other of filesIn.keys()) {
      if (other === g || !fits(g, other, maxDirFiles)) continue;
      let depth = 0;
      for (const m of filesIn.get(g)!) {
        for (const o of filesIn.get(other)!) depth = Math.max(depth, sharedDepth(dirOf(m), dirOf(o)));
      }
      if (depth > 0 && (!best || depth > best.depth)) best = { group: other, depth };
    }
    if (best) merge(best.group, g);
  }

  rehome(links, groupOf, filesIn, size, tokens, opts.budget, maxFiles * 2);
  splitByLanguage(groupOf, filesIn, size, tokens);

  // Each group is a paid reviewer session. Over the cap, the smallest group
  // joins the one it is most linked to, or failing that the nearest by
  // directory, as long as the result fits the budget.
  while (opts.maxGroups && filesIn.size > opts.maxGroups) {
    const g = bySize()[0];
    const pull = new Map<number, number>();
    for (const l of links) {
      const [ga, gb] = [groupOf.get(l.from)!, groupOf.get(l.to)!];
      if (ga === gb || (ga !== g && gb !== g)) continue;
      const other = ga === g ? gb : ga;
      pull.set(other, (pull.get(other) ?? 0) + l.weight);
    }
    let best: { group: number; weight: number; depth: number } | undefined;
    for (const other of filesIn.keys()) {
      if (other === g || size.get(g)! + size.get(other)! > opts.budget) continue;
      let depth = 0;
      for (const m of filesIn.get(g)!) {
        for (const o of filesIn.get(other)!) depth = Math.max(depth, sharedDepth(dirOf(m), dirOf(o)));
      }
      const weight = pull.get(other) ?? 0;
      const better =
        !best ||
        weight > best.weight ||
        (weight === best.weight && depth > best.depth) ||
        (weight === best.weight && depth === best.depth && size.get(other)! < size.get(best.group)!);
      if (better) best = { group: other, weight, depth };
    }
    if (!best) break;
    merge(best.group, g);
  }

  const ordered = [...filesIn.values()]
    .map((s) => [...s].sort())
    .sort((a, b) => sum(b, tokens) - sum(a, tokens) || a[0].localeCompare(b[0]));
  const used = new Map<string, number>();
  const indexOf = new Map<string, number>();
  const groups: CodeGroup[] = ordered.map((files, i) => {
    for (const f of files) indexOf.set(f, i);
    const base = groupSlug(files, tokens);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return { id: n > 1 ? `${base}-${n}` : base, files, tokens: sum(files, tokens), links: [] };
  });
  const cut: Link[] = [];
  for (const l of links) {
    const [ga, gb] = [indexOf.get(l.from), indexOf.get(l.to)];
    if (ga === undefined || gb === undefined) continue;
    if (ga === gb) groups[ga].links.push(l);
    else if (l.kind !== "dir") cut.push(l);
  }
  return { groups, cut };
}

/**
 * Moves single files toward the group holding their strongest symbol and pair
 * links. Smallest files move first: they cost the least room and are the ones
 * most likely to have been swept in early by an import before the link that
 * mattered came up.
 */
function rehome(
  links: Link[],
  groupOf: Map<string, number>,
  filesIn: Map<number, Set<string>>,
  size: Map<number, number>,
  tokens: Map<string, number>,
  budget: number,
  fileCap: number,
): void {
  const strong = new Map<string, Link[]>();
  for (const l of links) {
    if (!STRONG.has(l.kind)) continue;
    for (const f of [l.from, l.to]) strong.set(f, [...(strong.get(f) ?? []), l]);
  }
  const order = [...strong.keys()].sort((a, b) => tokens.get(a)! - tokens.get(b)! || a.localeCompare(b));
  for (let round = 0; round < 3; round++) {
    let moved = false;
    for (const f of order) {
      const home = groupOf.get(f)!;
      const pull = new Map<number, number>();
      for (const l of strong.get(f)!) {
        const other = l.from === f ? l.to : l.from;
        const g = groupOf.get(other)!;
        pull.set(g, (pull.get(g) ?? 0) + l.weight);
      }
      const atHome = pull.get(home) ?? 0;
      let best: { group: number; weight: number } | undefined;
      for (const [g, w] of pull) {
        if (g === home || w <= atHome || (best && w <= best.weight)) continue;
        if (size.get(g)! + tokens.get(f)! > budget || filesIn.get(g)!.size + 1 > fileCap) continue;
        best = { group: g, weight: w };
      }
      if (!best) continue;
      filesIn.get(home)!.delete(f);
      size.set(home, size.get(home)! - tokens.get(f)!);
      if (!filesIn.get(home)!.size) {
        filesIn.delete(home);
        size.delete(home);
      }
      filesIn.get(best.group)!.add(f);
      size.set(best.group, size.get(best.group)! + tokens.get(f)!);
      groupOf.set(f, best.group);
      moved = true;
    }
    if (!moved) break;
  }
}

const SPLIT_MIN_FILES = 4;

function languageFamily(file: string): string {
  if (CPP_HEADER.test(file) || CPP_SOURCE.test(file)) return "cpp";
  if (/\.[cm]?[jt]sx?$/.test(file)) return "js";
  return file.slice(file.lastIndexOf(".") + 1);
}

/**
 * Splits a group of at least SPLIT_MIN_FILES files that mixes languages into one
 * group per language, when every part has two or more files. A reviewer given
 * C++ and TypeScript together spends its turns on one side and skims the other:
 * on #13193 one reviewer for all eight files found nothing in two runs, while
 * reviewers given the TypeScript telemetry files apart found a defect there in
 * all three. The links the split cuts are reported like any other cut link, so
 * each side is told what the other holds.
 */
function splitByLanguage(
  groupOf: Map<string, number>,
  filesIn: Map<number, Set<string>>,
  size: Map<number, number>,
  tokens: Map<string, number>,
): void {
  let next = Math.max(-1, ...filesIn.keys()) + 1;
  const carve = (from: number, files: string[]) => {
    const id = next++;
    filesIn.set(id, new Set(files));
    size.set(id, sum(files, tokens));
    for (const f of files) {
      filesIn.get(from)!.delete(f);
      groupOf.set(f, id);
    }
    size.set(from, size.get(from)! - size.get(id)!);
    return id;
  };

  for (const g of [...filesIn.keys()]) {
    const files = [...filesIn.get(g)!].sort();
    if (files.length < SPLIT_MIN_FILES) continue;
    const parts = new Map<string, string[]>();
    for (const f of files) parts.set(languageFamily(f), [...(parts.get(languageFamily(f)) ?? []), f]);
    if (parts.size < 2 || [...parts.values()].some((p) => p.length < 2)) continue;
    const [, ...rest] = [...parts.values()].sort((a, b) => sum(b, tokens) - sum(a, tokens));
    for (const p of rest) carve(g, p);
  }
}

function sum(files: string[], tokens: Map<string, number>): number {
  return files.reduce((a, f) => a + (tokens.get(f) ?? 0), 0);
}

/** One line describing a link, for prompts and logs. */
export function describeLink(l: Link): string {
  switch (l.kind) {
    case "symbol": {
      const names = (l.names ?? []).slice(0, 3).map((n) => `\`${n}\``).join(", ");
      return `\`${l.from}\` uses ${names}, added in \`${l.to}\``;
    }
    case "pair":
      return `\`${l.from}\` and \`${l.to}\` are a test/source or header/source pair`;
    case "import":
      return `\`${l.from}\` imports \`${l.to}\``;
    case "dir":
      return `\`${l.from}\` and \`${l.to}\` share a directory`;
  }
}

/**
 * What a reviewer should know about the links cut away from their files: the
 * other end is being reviewed by someone else, so the contract between the two
 * has to be checked from this side.
 */
export function crossLinksFor(files: string[], links: Link[], max = 8): string[] {
  const mine = new Set(files);
  const rank: Record<LinkKind, number> = { symbol: 0, pair: 1, import: 2, dir: 3 };
  return links
    .filter((l) => l.kind !== "dir" && mine.has(l.from) !== mine.has(l.to))
    .sort((x, y) => rank[x.kind] - rank[y.kind] || y.weight - x.weight)
    .slice(0, max)
    .map(describeLink);
}

export interface NamedGroup {
  id: string;
  title: string;
  rationale?: string;
  files: string[];
  priority?: number;
}

export interface GroupNaming {
  groups?: Array<{ id?: unknown; title?: unknown; rationale?: unknown; priority?: unknown }>;
  moves?: Array<{ file?: unknown; to?: unknown; reason?: unknown }>;
}

export interface AppliedMove {
  file: string;
  from: string;
  to: string;
  reason: string;
}

/**
 * Applies the namer's answer to computed groups. The namer can title groups,
 * rank them, and move a file to another group; it cannot add, drop or invent
 * files, and a move is skipped when the file or group does not exist, when the
 * target would go over the budget, or when it would empty the source group.
 * Groups the namer did not mention keep their computed id as a title.
 */
export function applyGroupNaming(
  groups: CodeGroup[],
  naming: GroupNaming | undefined,
  budget: number,
  fileTokens: Map<string, number>,
): { units: NamedGroup[]; moves: AppliedMove[] } {
  const units = groups.map((g) => ({ id: g.id, files: [...g.files], tokens: g.tokens }));
  const byId = new Map(units.map((u) => [u.id, u]));
  const meta = new Map<string, { title?: string; rationale?: string; priority?: number }>();
  for (const n of naming?.groups ?? []) {
    if (typeof n?.id !== "string" || !byId.has(n.id)) continue;
    meta.set(n.id, {
      title: typeof n.title === "string" && n.title.trim() ? n.title.trim() : undefined,
      rationale: typeof n.rationale === "string" && n.rationale.trim() ? n.rationale.trim() : undefined,
      priority: typeof n.priority === "number" && Number.isFinite(n.priority) ? n.priority : undefined,
    });
  }
  const moves: AppliedMove[] = [];
  for (const m of naming?.moves ?? []) {
    if (typeof m?.file !== "string" || typeof m.to !== "string") continue;
    const from = units.find((u) => u.files.includes(m.file as string));
    const to = byId.get(m.to);
    if (!from || !to || from === to || from.files.length === 1) continue;
    const t = fileTokens.get(m.file) ?? 0;
    if (to.tokens + t > budget) continue;
    from.files = from.files.filter((f) => f !== m.file);
    from.tokens -= t;
    to.files = [...to.files, m.file].sort();
    to.tokens += t;
    moves.push({ file: m.file, from: from.id, to: to.id, reason: typeof m.reason === "string" ? m.reason : "" });
  }
  return {
    moves,
    units: units.map((u) => {
      const n = meta.get(u.id);
      return {
        id: u.id,
        title: n?.title ?? u.id,
        ...(n?.rationale ? { rationale: n.rationale } : {}),
        files: u.files,
        ...(n?.priority !== undefined ? { priority: n.priority } : {}),
      };
    }),
  };
}
