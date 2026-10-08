/**
 * Deterministic registry-completeness check.
 *
 * When a diff adds an entry to a list/registry/switch/spec object, find the
 * sibling entries surrounding it, then find files elsewhere in the repo that
 * carry several of those siblings but NOT the new entry. Those are candidate
 * omissions -- the #13053 failure mode -- computed without a model.
 *
 * Output is a fact table handed to the reviewing agent to verify, not a claim.
 */
import path from "node:path";
import { text } from "./lib/proc.ts";
import { readText } from "./lib/io.ts";
import { detectLanguage } from "./lib/languages.ts";
import { diffLines } from "./lib/hunks.ts";
import { EXTRA_EXCLUDES } from "./config.ts";

const EXCLUDE = [
  "node_modules/",
  "/dist/",
  "/build/",
  "/.next/",
  "/__snapshots__/",
  ".min.js",
  ".d.ts",
  ".js.map",
  "third-party/",
];

const GENERIC_IDENTS = new Set([
  "string", "number", "boolean", "object", "symbol", "unknown", "never", "void",
  "Record", "Promise", "Array", "Object", "String", "Number", "Boolean", "Error",
  "Partial", "Required", "Readonly", "Pick", "Omit", "Map", "Set", "Date", "JSON",
  "Math", "length", "name", "value", "data", "result", "options", "config",
  "context", "index", "count", "total", "logger", "console", "process", "buffer",
  "return", "export", "import", "default", "function", "typeof", "instanceof",
  "public", "private", "static", "struct", "class", "const", "enum", "true", "false", "null",
]);

const excluded = (p: string) => [...EXCLUDE, ...EXTRA_EXCLUDES].some((e) => p.includes(e));

/**
 * Text formats to index beyond the languages tree-sitter can parse.
 *
 * This pass does whole-token matching, not parsing, so restricting it to
 * parseable source buys nothing and costs the whole class of registry it was
 * written to catch: a chart pinning an image no `infra/ecr.ts` repo declares,
 * a pipeline step naming a queue that does not exist. Those live in YAML and
 * JSON, and an unindexed file looks the same as a file that omits the entry.
 */
const TEXT_EXTRA = new Set([
  ".yml", ".yaml", ".json", ".jsonc", ".toml", ".ini", ".env",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".sh", ".bash",
  ".tf", ".tfvars", ".sql", ".proto", ".graphql", ".gql",
]);

const TEXT_EXTRA_NAMES = new Set(["Dockerfile", "Makefile", "Procfile"]);

function indexable(f: string) {
  if (detectLanguage(f)) return true;
  const base = f.slice(f.lastIndexOf("/") + 1);
  if (TEXT_EXTRA_NAMES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  return dot > 0 && TEXT_EXTRA.has(base.slice(dot));
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/** An import/require/include line is never a registry. */
function isImportLine(line: string): boolean {
  const t = line.trim();
  return (
    /^import\b/.test(t) ||
    /^export\s+.*\bfrom\b/.test(t) ||
    /^#include\b/.test(t) ||
    /\brequire\s*\(/.test(t) ||
    /^from\b/.test(t)
  );
}

/** Identifiers that plausibly name a registry entry. */
function entryIdents(line: string): string[] {
  const out = new Set<string>();
  for (const m of line.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const id = m[0];
    if (id.length < 6) continue;
    if (GENERIC_IDENTS.has(id)) continue;
    // Registry entries are near-universally PascalCase specifiers/enums/consts,
    // or SCREAMING_SNAKE constants.
    if (!/^[A-Z]/.test(id)) continue;
    out.add(id);
  }
  for (const m of line.matchAll(/["'`]([A-Za-z0-9_.-]{6,})["'`]/g)) {
    // Module paths are not registry entries.
    if (m[1].includes("/") || m[1].startsWith(".")) continue;
    out.add(m[1]);
  }
  return [...out];
}

/**
 * A sibling name only carries signal if it is distinctive. Words like `Render`
 * appear in hundreds of files and would match anything.
 */
const MAX_SIBLING_SPREAD = 25;

/**
 * Replace every identifier, string and number with a placeholder to compare line
 * shape.
 *
 * The placeholders are punctuation on purpose. A letter used as one is matched
 * by the identifier pass that runs next over the same buffer, so a string ends
 * up indistinguishable from a bare name and `f("a")` shapes the same as `f(b)`.
 * Numbers are normalised for the opposite reason: left alone, two entries in a
 * numbered table shape differently from each other purely because their values
 * differ, and a sibling that should match does not.
 */
export function shape(line: string): string {
  return line
    .trim()
    .replace(/["'`][^"'`]*["'`]/g, "~")
    .replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, "X")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, "");
}

interface Hunk {
  file: string;
  lines: { kind: "add" | "del" | "ctx"; text: string; newLine: number }[];
}

/**
 * Built on the shared `diffLines` walker rather than reading the text itself:
 * the walker owns the two hard parts of the format — `diff.noprefix` omitting
 * the `b/` this parser used to require (under which a literal-prefix parser
 * finds no files at all and the check silently returns nothing), and body
 * lines that look like headers, which the walker rules out by counting down
 * the hunk header's own line counts. Only new-side line numbering lives here.
 */
export function parseDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let newLine = 0;
  for (const { file, line: raw } of diffLines(diff)) {
    // A change of file always passes through a `+++` header, which resets the
    // current hunk; lines before the next `@@` belong to no hunk.
    if (cur && file !== cur.file) cur = null;
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (header) {
      if (!file) continue; // deletion: the new side is /dev/null
      newLine = Number(header[1]);
      cur = { file, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("+")) cur.lines.push({ kind: "add", text: raw.slice(1), newLine: newLine++ });
    else if (raw.startsWith("-")) cur.lines.push({ kind: "del", text: raw.slice(1), newLine });
    else if (raw.startsWith(" ")) cur.lines.push({ kind: "ctx", text: raw.slice(1), newLine: newLine++ });
  }
  return hunks;
}

export interface RegistryFinding {
  newEntry: string;
  addedIn: string;
  addedAtLine: number;
  siblings: string[];
  /** Files carrying >=2 siblings but not newEntry. */
  missingIn: { file: string; siblingsPresent: string[] }[];
  /** Files carrying >=2 siblings AND newEntry -- shows the convention was followed there. */
  presentIn: { file: string; siblingsPresent: string[] }[];
}

interface RegistryResult {
  findings: RegistryFinding[];
  meta: Record<string, unknown>;
}

/**
 * This pass is an accelerant, on the same terms as the repo map: it makes a
 * review sharper, and a review without it is still a review. Both `git` calls
 * below reject on a non-zero exit or a signal, so a shallow subject checkout, a
 * base object this clone does not have, or an OOM on a large diff would
 * otherwise turn an optional signal into no review at all. The map build in
 * pipeline.ts fails soft for exactly this reason; the two have to agree.
 */
export async function registryCheck(opts: {
  repo: string;
  base: string;
  head: string;
}): Promise<RegistryResult> {
  try {
    return await computeRegistryCheck(opts);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`registry check unavailable, continuing without it: ${reason}`);
    return { findings: [], meta: { unavailable: reason } };
  }
}

async function computeRegistryCheck(opts: {
  repo: string;
  base: string;
  head: string;
}): Promise<RegistryResult> {
  const { repo, base, head } = opts;
  const cwd = repo;

  const diff = await text("git", ["-C", cwd, "diff", "-U5", `${base}..${head}`]);
  const hunks = parseDiff(diff);
  const changedFiles = new Set(hunks.map((h) => h.file));

  // 1. Detect registry-entry additions by line-shape agreement with neighbours.
  type Candidate = { newEntry: string; file: string; line: number; siblings: Set<string> };
  const candidates = new Map<string, Candidate>();

  for (const hunk of hunks) {
    for (let i = 0; i < hunk.lines.length; i++) {
      const L = hunk.lines[i];
      if (L.kind !== "add") continue;
      const text = L.text.trim();
      if (text.length < 8) continue;
      if (isImportLine(text)) continue;
      // Entry-ish: a list element, an object property, or a switch case.
      if (!/[,;]$/.test(text) && !/^case\b/.test(text) && !/:\s*\S+$/.test(text)) continue;
      const sh = shape(L.text);
      // Guards against a shape so trivial it matches anything, e.g. "X,".
      // Distinctiveness of the sibling names does the real filtering below.
      if (sh.length < 4) continue;

      const mine = entryIdents(L.text);
      if (mine.length === 0) continue;

      // Context lines with the same shape, within +/-5 lines.
      const sibs = new Set<string>();
      let shapeMatches = 0;
      for (let j = Math.max(0, i - 5); j <= Math.min(hunk.lines.length - 1, i + 5); j++) {
        if (j === i) continue;
        const C = hunk.lines[j];
        if (C.kind !== "ctx") continue;
        if (shape(C.text) !== sh) continue;
        shapeMatches++;
        for (const id of entryIdents(C.text)) if (!mine.includes(id)) sibs.add(id);
      }
      if (shapeMatches < 2 || sibs.size < 2) continue;

      for (const ne of mine) {
        const key = `${ne}@${hunk.file}`;
        const existing = candidates.get(key);
        if (existing) {
          for (const s of sibs) existing.siblings.add(s);
        } else {
          candidates.set(key, { newEntry: ne, file: hunk.file, line: L.newLine, siblings: new Set(sibs) });
        }
      }
    }
  }

  if (candidates.size === 0) return { findings: [], meta: { hunks: hunks.length, candidates: 0 } };

  // 2. Build an identifier -> files index over tracked source files.
  const tracked = (await text("git", ["-C", cwd, "ls-files"])).trim().split("\n");
  const sourceFiles = tracked.filter((f) => f && !excluded(f) && indexable(f));

  const wanted = new Set<string>();
  for (const c of candidates.values()) {
    wanted.add(c.newEntry);
    for (const s of c.siblings) wanted.add(s);
  }

  const identFiles = new Map<string, Set<string>>();
  for (const id of wanted) identFiles.set(id, new Set());

  // Whole-token matching, not substring containment. This check exists to notice
  // that an entry is missing from a file, and `content.includes("Fork")` is true
  // of any file mentioning `ForkProcess` — so the one file that omits the entry
  // gets recorded as having it and the omission is never reported. The same
  // over-matching inflates the spread counts below, which then discards
  // distinctive siblings as too common.
  const simple = new Map<string, boolean>();
  const patterns = new Map<string, RegExp>();
  for (const id of wanted) {
    const isSimple = /^[A-Za-z0-9_$]+$/.test(id);
    simple.set(id, isSimple);
    // Entries that are not bare identifiers (hyphenated image names, dotted
    // paths) still need their edges checked, or `cost-rollup` matches inside
    // `cost-rollup-v2`.
    if (!isSimple) {
      patterns.set(id, new RegExp(`(?<![A-Za-z0-9_$-])${escapeRegExp(id)}(?![A-Za-z0-9_$-])`));
    }
  }

  let scanned = 0;
  for (const f of sourceFiles) {
    let content: string;
    try {
      content = await readText(path.join(cwd, f));
    } catch {
      continue;
    }
    if (content.length > 2_000_000) continue;
    scanned++;
    const tokens = new Set(content.match(/[A-Za-z0-9_$]+/g) ?? []);
    for (const id of wanted) {
      const hit = simple.get(id) ? tokens.has(id) : patterns.get(id)!.test(content);
      if (hit) identFiles.get(id)!.add(f);
    }
  }

  // 3. For each candidate, find files carrying several siblings but not the new entry.
  const findings: RegistryFinding[] = [];
  for (const c of candidates.values()) {
    // Only distinctive siblings carry signal.
    const sibs = [...c.siblings].filter((s) => {
      const n = (identFiles.get(s) ?? new Set()).size;
      return n > 0 && n <= MAX_SIBLING_SPREAD;
    });
    if (sibs.length < 2) continue;
    if ((identFiles.get(c.newEntry) ?? new Set()).size > MAX_SIBLING_SPREAD) continue;
    const perFile = new Map<string, string[]>();
    for (const s of sibs) {
      for (const f of identFiles.get(s) ?? []) {
        if (!perFile.has(f)) perFile.set(f, []);
        perFile.get(f)!.push(s);
      }
    }
    const hasNew = identFiles.get(c.newEntry) ?? new Set<string>();
    const missingIn: RegistryFinding["missingIn"] = [];
    const presentIn: RegistryFinding["presentIn"] = [];
    for (const [f, present] of perFile) {
      if (present.length < 2) continue;
      if (f === c.file) continue;
      if (hasNew.has(f)) presentIn.push({ file: f, siblingsPresent: present.sort() });
      else missingIn.push({ file: f, siblingsPresent: present.sort() });
    }
    if (missingIn.length === 0) continue;
    missingIn.sort((a, b) => b.siblingsPresent.length - a.siblingsPresent.length);
    presentIn.sort((a, b) => b.siblingsPresent.length - a.siblingsPresent.length);
    findings.push({
      newEntry: c.newEntry,
      addedIn: c.file,
      addedAtLine: c.line,
      siblings: sibs.sort(),
      missingIn: missingIn.slice(0, 6),
      presentIn: presentIn.slice(0, 6),
    });
  }

  findings.sort((a, b) => b.missingIn.length - a.missingIn.length);
  return {
    findings,
    meta: { hunks: hunks.length, candidates: candidates.size, filesScanned: scanned, changedFiles: changedFiles.size },
  };
}

export function renderRegistryReport(findings: RegistryFinding[]): string {
  if (findings.length === 0) return "";
  const out: string[] = [
    "## Registry-completeness signals (computed, unverified)",
    "",
    "This diff adds entries to lists that look like registries. For each new entry, these are",
    "files that already carry several of its sibling entries but do NOT mention the new one.",
    "This is a mechanical text signal, not a finding. Open the files and decide whether the",
    "omission matters. If precedent is mixed, that is itself worth asking the author about.",
    "",
  ];
  for (const f of findings) {
    out.push(`### \`${f.newEntry}\` added in \`${f.addedIn}:${f.addedAtLine}\``);
    out.push(`Siblings used for comparison: ${f.siblings.map((s) => `\`${s}\``).join(", ")}`);
    out.push("");
    out.push("Carries siblings but NOT this entry:");
    for (const m of f.missingIn) {
      out.push(`- \`${m.file}\` — has ${m.siblingsPresent.map((s) => `\`${s}\``).join(", ")}`);
    }
    if (f.presentIn.length) {
      out.push("");
      out.push("Carries siblings AND this entry (convention followed here):");
      for (const p of f.presentIn) {
        out.push(`- \`${p.file}\` — has ${p.siblingsPresent.map((s) => `\`${s}\``).join(", ")}`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}
