/**
 * module-resolver.ts - resolve non-relative import specifiers to project files.
 *
 * Relative imports are easy; `@/components/sidebar/SidebarPanel` is not, because
 * the mapping lives in whichever tool the project configured. This resolves in
 * layers and takes the first answer:
 *
 *   1. tsconfig/jsconfig `paths` (with `extends` and `references`), then `baseUrl`
 *   2. package.json `imports` (`#internal/*` subpath imports)
 *   3. workspace packages, by package.json `name`
 *   4. aliases inferred from the file list: every unresolved specifier sharing a
 *      prefix (`@/`, or a bare first segment like `ui/`) votes for the
 *      directory that makes the most of them exist
 *
 * Nothing here touches the filesystem directly. The caller supplies the file
 * list and a reader, so the same code works on a git checkout and on the
 * original sources recovered from source maps, where there is no
 * tsconfig and inference is the only layer that applies.
 *
 * Bundler config files (vite.config.ts, webpack.config.js) are code and are not
 * evaluated. Their aliases almost always point a symbol prefix at `src/`, which
 * inference recovers.
 */

import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

export interface ProjectFiles {
  /** Repo-relative paths, forward slashes. */
  paths: ReadonlySet<string>;
  /** File contents, or undefined when unreadable. May be asked for paths outside `paths`. */
  read(path: string): string | undefined;
}

export function projectFilesFromDisk(repoRoot: string, paths: Iterable<string>): ProjectFiles {
  return {
    paths: new Set(paths),
    read(p) {
      const abs = join(repoRoot, p);
      try {
        return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** Every git-tracked file in `repo`, read from disk on demand. */
export function projectFilesFromGit(repo: string): ProjectFiles {
  const out = execFileSync("git", ["-C", repo, "ls-files"], { encoding: "utf8", maxBuffer: 256 << 20 });
  return projectFilesFromDisk(repo, out.split("\n").filter(Boolean));
}

export function projectFilesFromMap(files: ReadonlyMap<string, string>): ProjectFiles {
  return { paths: new Set(files.keys()), read: (p) => files.get(p) };
}

export type ResolutionKind =
  | "relative"
  | "tsconfig"
  | "base-url"
  | "package-imports"
  | "workspace"
  | "inferred";

export interface Resolved {
  path: string;
  via: ResolutionKind;
}

export interface ImportRef {
  from: string;
  spec: string;
}

export interface InferredAlias {
  /** Directory of the package.json that scopes the alias; "" for the repo root. */
  scope: string;
  /** `@/`, `~/`, `#lib/`, `@scope/`, or a bare first segment such as `ui/`. */
  prefix: string;
  /** What replaces `prefix`: a directory with trailing slash, or "". `ui/` -> `src/ui/`. */
  root: string;
  /** Distinct specifiers that resolved under `root`, out of `total` with this prefix. */
  hits: number;
  total: number;
}

// ============================================================================
// File expansion
// ============================================================================

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const EXT_RE = /\.(?:d\.ts|tsx?|jsx?|mts|cts|mjs|cjs)$/;

/** The project file a specifier-shaped path names, trying extensions and index files. */
export function expandFile(base: string, files: ReadonlySet<string>): string | undefined {
  const p = posix.normalize(base).replace(/^\.\//, "");
  if (p.startsWith("../")) return undefined;
  if (files.has(p)) return p;
  // TypeScript ESM projects write `./foo.js` for `./foo.ts`.
  const ext = posix.extname(p);
  for (const swap of JS_TO_TS[ext] ?? []) {
    const swapped = p.slice(0, -ext.length) + swap;
    if (files.has(swapped)) return swapped;
  }
  for (const e of SOURCE_EXTENSIONS) if (files.has(p + e)) return p + e;
  for (const e of SOURCE_EXTENSIONS) if (files.has(`${p}/index${e}`)) return `${p}/index${e}`;
  return undefined;
}

// ============================================================================
// JSONC
// ============================================================================

/** JSON with comments and trailing commas, as tsconfig allows. Undefined on bad input. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ============================================================================
// tsconfig
// ============================================================================

interface PathsRule {
  pattern: string;
  /** Repo-relative target patterns, `*` kept. */
  targets: string[];
}

interface TsProject {
  /** Directory of the tsconfig that applies; "" for the repo root. */
  dir: string;
  /** Repo-relative baseUrl directory, if one was set. */
  baseUrl?: string;
  paths: PathsRule[];
}

interface RawCompilerOptions {
  baseUrl?: string;
  baseUrlFrom?: string;
  paths?: Record<string, string[]>;
  pathsFrom?: string;
}

const CONFIG_NAME_RE = /(^|\/)(tsconfig[^/]*|jsconfig[^/]*)\.json$/;

function dirOf(p: string): string {
  const d = posix.dirname(p);
  return d === "." ? "" : d;
}

function joinRel(dir: string, p: string): string {
  return posix.normalize(dir ? `${dir}/${p}` : p).replace(/^\.\//, "").replace(/^\.$/, "");
}

function readJson(files: ProjectFiles, p: string): Record<string, unknown> | undefined {
  const text = files.read(p);
  if (text === undefined) return undefined;
  const v = parseJsonc(text);
  return isRecord(v) ? v : undefined;
}

function extendsTarget(spec: string, fromDir: string, files: ProjectFiles): string | undefined {
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const p = joinRel(fromDir, spec);
    return p.endsWith(".json") ? p : `${p}.json`;
  }
  // `@tsconfig/next` or `some-pkg/tsconfig.base.json`, which only exist after an
  // install. Base configs from npm almost never set `paths`, so a miss costs nothing.
  const candidates = spec.endsWith(".json")
    ? [`node_modules/${spec}`]
    : [`node_modules/${spec}/tsconfig.json`, `node_modules/${spec}.json`];
  return candidates.find((c) => files.read(c) !== undefined);
}

function loadCompilerOptions(
  files: ProjectFiles,
  path: string,
  seen: Set<string> = new Set(),
): RawCompilerOptions {
  if (seen.has(path)) return {};
  seen.add(path);
  const json = readJson(files, path);
  if (!json) return {};
  const dir = dirOf(path);
  let merged: RawCompilerOptions = {};
  const ext = json.extends;
  for (const spec of typeof ext === "string" ? [ext] : Array.isArray(ext) ? ext : []) {
    if (typeof spec !== "string") continue;
    const target = extendsTarget(spec, dir, files);
    if (target) merged = { ...merged, ...loadCompilerOptions(files, target, seen) };
  }
  const opts = isRecord(json.compilerOptions) ? json.compilerOptions : {};
  if (typeof opts.baseUrl === "string") {
    merged.baseUrl = opts.baseUrl;
    merged.baseUrlFrom = dir;
  }
  if (isRecord(opts.paths)) {
    const paths: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(opts.paths)) {
      if (Array.isArray(v)) paths[k] = v.filter((t): t is string => typeof t === "string");
    }
    merged.paths = paths;
    merged.pathsFrom = dir;
  }
  return merged;
}

function referencedConfigs(files: ProjectFiles, path: string): string[] {
  const refs = readJson(files, path)?.references;
  if (!Array.isArray(refs)) return [];
  const dir = dirOf(path);
  return refs.flatMap((r) => {
    if (!isRecord(r) || typeof r.path !== "string") return [];
    const p = joinRel(dir, r.path);
    return [p.endsWith(".json") ? p : `${p}/tsconfig.json`];
  });
}

function toProject(dir: string, raw: RawCompilerOptions, extra: RawCompilerOptions[]): TsProject {
  const baseUrl =
    raw.baseUrl !== undefined ? joinRel(raw.baseUrlFrom ?? dir, raw.baseUrl) : undefined;
  const paths: PathsRule[] = [];
  for (const opts of [raw, ...extra]) {
    if (!opts.paths) continue;
    // Since TypeScript 4.1, `paths` without `baseUrl` resolve against the config
    // that declares them.
    const from =
      opts.baseUrl !== undefined
        ? joinRel(opts.baseUrlFrom ?? dir, opts.baseUrl)
        : (opts.pathsFrom ?? dir);
    for (const [pattern, targets] of Object.entries(opts.paths)) {
      if (paths.some((r) => r.pattern === pattern)) continue;
      paths.push({ pattern, targets: targets.map((t) => joinRel(from, t)) });
    }
  }
  return { dir, ...(baseUrl !== undefined ? { baseUrl } : {}), paths };
}

/**
 * One project per directory holding a tsconfig.json or jsconfig.json. A solution
 * config (the Vite template's `tsconfig.json` with only `references`) takes the
 * `paths` of the configs it references, since that is where the template puts them.
 */
function loadTsProjects(files: ProjectFiles): Map<string, TsProject> {
  const byDir = new Map<string, TsProject>();
  const configs = [...files.paths].filter(
    (p) => CONFIG_NAME_RE.test(p) && !p.includes("node_modules/"),
  );
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    for (const p of configs) {
      if (posix.basename(p) !== name) continue;
      const dir = dirOf(p);
      if (byDir.has(dir)) continue;
      const raw = loadCompilerOptions(files, p);
      const extra = raw.paths
        ? []
        : referencedConfigs(files, p).map((r) => loadCompilerOptions(files, r));
      byDir.set(dir, toProject(dir, raw, extra));
    }
  }
  return byDir;
}

function matchPattern(pattern: string, spec: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === spec ? "" : undefined;
  const pre = pattern.slice(0, star);
  const post = pattern.slice(star + 1);
  if (spec.length < pre.length + post.length) return undefined;
  if (!spec.startsWith(pre) || !spec.endsWith(post)) return undefined;
  return spec.slice(pre.length, spec.length - post.length);
}

/** Exact patterns beat wildcards; among wildcards the longest literal prefix wins. */
function patternRank(pattern: string): number {
  const star = pattern.indexOf("*");
  return star === -1 ? Infinity : star;
}

function resolvePaths(rules: PathsRule[], spec: string, files: ReadonlySet<string>) {
  let best: { rule: PathsRule; capture: string } | undefined;
  for (const rule of rules) {
    const capture = matchPattern(rule.pattern, spec);
    if (capture === undefined) continue;
    if (!best || patternRank(rule.pattern) > patternRank(best.rule.pattern)) best = { rule, capture };
  }
  if (!best) return undefined;
  for (const target of best.rule.targets) {
    const hit = expandFile(target.replace("*", best.capture), files);
    if (hit) return hit;
  }
  return undefined;
}

// ============================================================================
// package.json: subpath imports, workspaces, dependencies
// ============================================================================

interface PackageInfo {
  dir: string;
  name?: string;
  imports?: Record<string, unknown>;
  exports?: unknown;
  entry: string[];
}

const CONDITION_ORDER = ["source", "development", "import", "module", "node", "require", "browser", "default", "types"];

function conditionTarget(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const item of v) {
      const t = conditionTarget(item);
      if (t) return t;
    }
    return undefined;
  }
  if (!isRecord(v)) return undefined;
  for (const c of CONDITION_ORDER) if (c in v) return conditionTarget(v[c]);
  for (const value of Object.values(v)) {
    const t = conditionTarget(value);
    if (t) return t;
  }
  return undefined;
}

function resolveSubpathMap(
  map: Record<string, unknown>,
  key: string,
  dir: string,
  files: ReadonlySet<string>,
): string | undefined {
  let best: { target: string; capture: string; len: number } | undefined;
  for (const [pattern, value] of Object.entries(map)) {
    const capture = matchPattern(pattern, key);
    if (capture === undefined) continue;
    const target = conditionTarget(value);
    if (!target) continue;
    const len = patternRank(pattern);
    if (!best || len > best.len) best = { target, capture, len };
  }
  if (!best) return undefined;
  return sourceFor(joinRel(dir, best.target.replaceAll("*", best.capture)), dir, files);
}

/**
 * Workspace packages often point `main` or `exports` at build output that is
 * not checked in. The source usually sits at the same path under `src/` (or
 * `ts/` when the output directory is `js/`).
 */
function sourceFor(target: string, dir: string, files: ReadonlySet<string>): string | undefined {
  const direct = expandFile(target, files);
  if (direct) return direct;
  const rel = dir ? target.slice(dir.length + 1) : target;
  const m = /^(dist|lib|build|out|js)\/(.*)$/.exec(rel);
  if (!m) return undefined;
  for (const src of m[1] === "js" ? ["ts", "src"] : ["src"]) {
    const hit = expandFile(joinRel(dir, `${src}/${m[2]}`).replace(EXT_RE, ""), files);
    if (hit) return hit;
  }
  return undefined;
}

function loadPackages(files: ProjectFiles): Map<string, PackageInfo> {
  const out = new Map<string, PackageInfo>();
  for (const p of files.paths) {
    if (posix.basename(p) !== "package.json" || p.includes("node_modules/")) continue;
    const json = readJson(files, p);
    if (!json) continue;
    const entry = [json.source, json.module, json.main, json.types, json.typings].filter(
      (v): v is string => typeof v === "string",
    );
    out.set(dirOf(p), {
      dir: dirOf(p),
      ...(typeof json.name === "string" ? { name: json.name } : {}),
      ...(isRecord(json.imports) ? { imports: json.imports } : {}),
      ...(json.exports !== undefined ? { exports: json.exports } : {}),
      entry,
    });
  }
  return out;
}

function loadDependencyNames(files: ProjectFiles, packages: Map<string, PackageInfo>): Set<string> {
  const names = new Set<string>();
  for (const dir of packages.keys()) {
    const json = readJson(files, joinRel(dir, "package.json"));
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = json?.[field];
      if (isRecord(deps)) for (const n of Object.keys(deps)) names.add(n);
    }
  }
  return names;
}

/** `@scope/pkg/sub` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
export function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function resolveWorkspace(pkg: PackageInfo, sub: string, files: ReadonlySet<string>): string | undefined {
  const key = sub ? `./${sub}` : ".";
  if (pkg.exports !== undefined) {
    const map =
      isRecord(pkg.exports) && Object.keys(pkg.exports).some((k) => k.startsWith("."))
        ? pkg.exports
        : { ".": pkg.exports };
    const hit = resolveSubpathMap(map, key, pkg.dir, files);
    if (hit) return hit;
  }
  if (!sub) {
    for (const e of pkg.entry) {
      const hit = sourceFor(joinRel(pkg.dir, e), pkg.dir, files);
      if (hit) return hit;
    }
    return expandFile(joinRel(pkg.dir, "src/index"), files) ?? expandFile(joinRel(pkg.dir, "index"), files);
  }
  return expandFile(joinRel(pkg.dir, sub), files) ?? expandFile(joinRel(pkg.dir, `src/${sub}`), files);
}

// ============================================================================
// Inference
// ============================================================================

const BUILTINS = new Set(builtinModules);

/** Symbol-led first segments are aliases by convention: `@/`, `~/`, `#lib/`, `$lib/`. */
function aliasPrefix(spec: string): string | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0) return undefined;
  const first = spec.slice(0, slash);
  return /^[@~#$]/.test(first) ? `${first}/` : undefined;
}

class SuffixIndex {
  /** Extensionless path (or the directory of an index file) by last segment. */
  private byLast = new Map<string, string[]>();

  constructor(files: ReadonlySet<string>) {
    for (const f of files) {
      if (!EXT_RE.test(f) || f.includes("node_modules/")) continue;
      const stem = f.replace(EXT_RE, "");
      this.add(stem);
      if (posix.basename(stem) === "index") this.add(dirOf(stem));
    }
  }

  private add(stem: string) {
    if (!stem) return;
    const last = posix.basename(stem);
    const list = this.byLast.get(last);
    if (list) list.push(stem);
    else this.byLast.set(last, [stem]);
  }

  /** Every directory R such that R + rest names a project file. */
  roots(rest: string): string[] {
    const clean = rest.replace(EXT_RE, "").replace(/\/$/, "");
    const stems = this.byLast.get(posix.basename(clean)) ?? [];
    const out = new Set<string>();
    for (const s of stems) {
      if (s === clean) out.add("");
      else if (s.endsWith(`/${clean}`)) out.add(s.slice(0, s.length - clean.length));
    }
    return [...out];
  }
}

const MIN_SHARE = 0.6;
const LONE_SYMBOL_PREFIX = /^[@~#$]\/$/;

/**
 * The group a specifier votes in: its alias prefix (`@/`, `~/`, `#lib/`,
 * `@scope/`) or, for a bare path such as `ui/actions/app`, its first segment.
 * Bare specifiers with no slash name a package or nothing, so they never vote.
 */
function inferenceKey(spec: string): { prefix: string; bare: boolean } | undefined {
  const symbol = aliasPrefix(spec);
  if (symbol) return { prefix: symbol, bare: false };
  const slash = spec.indexOf("/");
  return slash > 0 ? { prefix: spec.slice(0, slash + 1), bare: true } : undefined;
}

/**
 * Learn alias targets from specifiers no configuration resolved. Grouped by the
 * nearest package.json, so each app in a monorepo gets its own `@/`, and by
 * prefix, so one alias does not dilute another. A target is accepted only when
 * it makes at least MIN_SHARE of the group's distinct specifiers exist, beats
 * the runner-up outright, and explains at least two specifiers. `@/`, `~/`,
 * `#/` and `$/` are accepted on one specifier, since nothing else uses those
 * spellings; `@sentry/utils` matching a local `utils.ts` once proves nothing.
 */
export function inferAliases(
  refs: Iterable<ImportRef>,
  files: ReadonlySet<string>,
  scopeOf: (file: string) => string,
): InferredAlias[] {
  const groups = new Map<string, { scope: string; prefix: string; bare: boolean; specs: Set<string> }>();
  for (const { from, spec } of refs) {
    const key = inferenceKey(spec);
    if (!key) continue;
    const scope = scopeOf(from);
    const id = `${scope}\0${key.prefix}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { scope, ...key, specs: new Set() }));
    g.specs.add(spec);
  }

  const index = new SuffixIndex(files);
  const out: InferredAlias[] = [];
  for (const { scope, prefix, bare, specs } of groups.values()) {
    const votes = new Map<string, number>();
    for (const spec of specs) {
      // A bare `ui/x` keeps its first segment; an alias `@/x` replaces it.
      for (const root of index.roots(bare ? spec : spec.slice(prefix.length))) {
        if (scope && root !== scope && !root.startsWith(`${scope}/`)) continue;
        votes.set(root, (votes.get(root) ?? 0) + 1);
      }
    }
    const ranked = [...votes].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
    const [best, second] = ranked;
    if (!best) continue;
    const [root, hits] = best;
    if (second && second[1] === hits) continue;
    if (hits < MIN_SHARE * specs.size) continue;
    if (hits < 2 && !LONE_SYMBOL_PREFIX.test(prefix)) continue;
    // `@scope/` mapping onto the repository root would mean an npm scope's
    // packages are top-level project folders.
    if (!bare && !LONE_SYMBOL_PREFIX.test(prefix) && root === "") continue;
    out.push({ scope, prefix, root: bare ? root + prefix : root, hits, total: specs.size });
  }
  return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.prefix.localeCompare(b.prefix));
}

// ============================================================================
// Resolver
// ============================================================================

export interface ModuleResolverOptions {
  /** Specifiers to learn aliases from. Omit to skip inference. */
  infer?: Iterable<ImportRef>;
}

export class ModuleResolver {
  readonly aliases: InferredAlias[];
  private tsProjects: Map<string, TsProject>;
  private packages: Map<string, PackageInfo>;
  private workspaces = new Map<string, PackageInfo>();
  private deps: Set<string>;
  private nearestCache = new Map<string, { ts?: TsProject; pkg?: PackageInfo }>();

  private constructor(private files: ProjectFiles, opts: ModuleResolverOptions) {
    this.tsProjects = loadTsProjects(files);
    this.packages = loadPackages(files);
    for (const p of this.packages.values()) if (p.name) this.workspaces.set(p.name, p);
    this.deps = loadDependencyNames(files, this.packages);
    // Source-map file lists carry no package.json but do name the installed
    // packages, as `node_modules/<name>/...` paths.
    for (const p of files.paths) {
      for (const m of p.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//g)) this.deps.add(m[1]);
    }

    const unresolved: ImportRef[] = [];
    if (opts.infer) {
      for (const ref of opts.infer) {
        if (this.isCandidateAlias(ref.spec) && !this.resolveConfigured(ref.spec, ref.from)) {
          unresolved.push(ref);
        }
      }
    }
    this.aliases = inferAliases(unresolved, files.paths, (f) => this.nearest(f).pkg?.dir ?? "");
  }

  static create(files: ProjectFiles, opts: ModuleResolverOptions = {}): ModuleResolver {
    return new ModuleResolver(files, opts);
  }

  /** True for specifiers that name an installed package or a Node builtin. */
  isExternal(spec: string): boolean {
    if (spec.startsWith("node:") || BUILTINS.has(packageName(spec))) return true;
    return this.deps.has(packageName(spec));
  }

  resolve(spec: string, from: string): Resolved | undefined {
    if (spec.startsWith(".")) {
      const path = expandFile(joinRel(dirOf(from), spec), this.files.paths);
      return path ? { path, via: "relative" } : undefined;
    }
    if (spec.startsWith("/")) return undefined;
    const configured = this.resolveConfigured(spec, from);
    if (configured) return configured;
    if (!this.isCandidateAlias(spec)) return undefined;
    return this.resolveInferred(spec, from);
  }

  private isCandidateAlias(spec: string): boolean {
    if (spec.startsWith(".") || spec.startsWith("/") || spec.includes(":")) return false;
    return !this.isExternal(spec);
  }

  private nearest(file: string): { ts?: TsProject; pkg?: PackageInfo } {
    const dir = dirOf(file);
    const cached = this.nearestCache.get(dir);
    if (cached) return cached;
    let ts: TsProject | undefined;
    let pkg: PackageInfo | undefined;
    for (let d = dir; ; d = dirOf(d)) {
      ts ??= this.tsProjects.get(d);
      pkg ??= this.packages.get(d);
      if ((ts && pkg) || d === "") break;
    }
    const found = { ...(ts ? { ts } : {}), ...(pkg ? { pkg } : {}) };
    this.nearestCache.set(dir, found);
    return found;
  }

  private resolveConfigured(spec: string, from: string): Resolved | undefined {
    const { ts, pkg } = this.nearest(from);
    const paths = this.files.paths;
    if (ts) {
      const hit = resolvePaths(ts.paths, spec, paths);
      if (hit) return { path: hit, via: "tsconfig" };
    }
    if (spec.startsWith("#") && pkg?.imports) {
      const hit = resolveSubpathMap(pkg.imports, spec, pkg.dir, paths);
      if (hit) return { path: hit, via: "package-imports" };
    }
    const name = packageName(spec);
    const ws = this.workspaces.get(name);
    if (ws) {
      const hit = resolveWorkspace(ws, spec.slice(name.length + 1), paths);
      if (hit) return { path: hit, via: "workspace" };
    }
    if (ts?.baseUrl !== undefined && !this.isExternal(spec)) {
      const hit = expandFile(joinRel(ts.baseUrl, spec), paths);
      if (hit) return { path: hit, via: "base-url" };
    }
    return undefined;
  }

  private resolveInferred(spec: string, from: string): Resolved | undefined {
    const scope = this.nearest(from).pkg?.dir ?? "";
    const prefix = inferenceKey(spec)?.prefix;
    if (!prefix) return undefined;
    const alias =
      this.aliases.find((a) => a.scope === scope && a.prefix === prefix) ??
      this.aliases.find((a) => a.scope === "" && a.prefix === prefix);
    if (!alias) return undefined;
    const path = expandFile(alias.root + spec.slice(prefix.length), this.files.paths);
    return path ? { path, via: "inferred" } : undefined;
  }
}

export interface OutlineImports {
  path: string;
  /** Resolved repo-relative paths. */
  imports: string[];
  /** Specifiers the outline parser could not resolve. */
  externalImports: string[];
}

/**
 * Resolve what the outline parser left in `externalImports` (aliases,
 * workspace packages, baseUrl paths) and move each hit into `imports`, in
 * place. Inference learns from every outline passed in, so pass them all at
 * once.
 */
export function resolveOutlineImports(all: OutlineImports[], files: ProjectFiles): ModuleResolver {
  // C++ includes are resolved by the outline parser against every ancestor directory.
  const outlines = all.filter((o) => EXT_RE.test(o.path));
  const infer = outlines.flatMap((o) => o.externalImports.map((spec) => ({ from: o.path, spec })));
  const resolver = ModuleResolver.create(files, { infer });
  for (const o of outlines) {
    const external: string[] = [];
    const imports = new Set(o.imports);
    for (const spec of o.externalImports) {
      const hit = resolver.resolve(spec, o.path);
      if (hit && hit.path !== o.path) imports.add(hit.path);
      else if (!hit) external.push(spec);
    }
    o.imports = [...imports].sort();
    o.externalImports = external;
  }
  return resolver;
}
