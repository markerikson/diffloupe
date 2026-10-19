/**
 * code-outline.ts - tree-sitter symbol extraction for repo maps.
 *
 * Parses TypeScript/JavaScript and C/C++ source with the prebuilt wasm grammars
 * and returns declarations plus the file's import/include edges.
 *
 * Queries are embedded here rather than read from node_modules/<grammar>/queries/tags.scm:
 * the shipped TypeScript tags.scm only holds TS-specific additions and expects to be
 * concatenated with the JavaScript one, and a sandboxed plugin cannot rely on that layout.
 *
 * Requires web-tree-sitter, tree-sitter-typescript and tree-sitter-cpp. Nothing
 * else in this directory does, so build-map.ts loads it lazily and the review
 * runs without a map when they are absent.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { detectLanguage, type LanguageId } from "./languages.ts";

export { detectLanguage, type LanguageId };

/** A repo root on disk, or the set of repo-relative file paths at some commit. */
export type SourceFiles = string | ReadonlySet<string>;
import { Language, Parser, Query } from "web-tree-sitter";

// ============================================================================
// Types
// ============================================================================

export type SymbolKind =
  | "class"
  | "interface"
  | "function"
  | "method"
  | "type"
  | "enum"
  | "module"
  | "variable";

export interface SymbolDef {
  name: string;
  kind: SymbolKind;
  line: number;
  /** TS: has an `export` keyword. C++: declared outside any function body. */
  exported: boolean;
  /** Enclosing class/struct/interface name, if any */
  container?: string;
  /** Declaration text with the body stripped, whitespace collapsed */
  signature: string;
}

export interface FileOutline {
  /** Repo-relative path, forward slashes */
  path: string;
  language: LanguageId;
  lines: number;
  symbols: SymbolDef[];
  /** Repo-relative paths this file imports/includes, resolved where possible */
  imports: string[];
  /** Unresolved import specifiers (bare package names, missing files) */
  externalImports: string[];
  /** tree-sitter recovered from at least one syntax error (usually macros) */
  parseError: boolean;
}

/** An outline before its imports are resolved, which is the part worth caching by content. */
export interface RawOutline {
  language: LanguageId;
  lines: number;
  symbols: SymbolDef[];
  /** Import specifiers as written, in source order */
  importSpecs: string[];
  parseError: boolean;
}

// ============================================================================
// Queries
// ============================================================================

const TS_DEFINITION_QUERY = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(function_signature name: (identifier) @name) @definition.function

(class_declaration name: (type_identifier) @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class

(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(internal_module name: (identifier) @name) @definition.module

(method_definition name: (property_identifier) @name) @definition.method
(method_signature name: (property_identifier) @name) @definition.method
(abstract_method_signature name: (property_identifier) @name) @definition.method

(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression)]) @definition.function

; Any other value binding. A registry in this codebase is usually an exported
; const object, which is exactly the shape the pattern above does not match, and
; the symbol index is what the map's "added here but not to its siblings" pass
; reads. Declarators bound to a function match both patterns; collectSymbols
; keeps the function one.
(variable_declarator name: (identifier) @name) @definition.variable
`;

const TS_IMPORT_QUERY = `
(import_statement source: (string) @path)
(export_statement source: (string) @path)
`;

const CPP_DEFINITION_QUERY = `
(struct_specifier name: (type_identifier) @name body: (_)) @definition.class
; A body is required for the same reason struct_specifier requires one: without
; it, a forward declaration indexes as a definition, and the symbol index then
; attributes the class to every file that forward-declares it.
(class_specifier name: (type_identifier) @name body: (_)) @definition.class
(declaration type: (union_specifier name: (type_identifier) @name)) @definition.class

(function_declarator declarator: (identifier) @name) @definition.function
(function_declarator declarator: (field_identifier) @name) @definition.method
(function_declarator
  declarator: (qualified_identifier
    scope: (namespace_identifier)
    name: (identifier) @name)) @definition.method

(type_definition declarator: (type_identifier) @name) @definition.type
(enum_specifier name: (type_identifier) @name) @definition.enum
(namespace_definition name: (namespace_identifier) @name) @definition.module
`;

const CPP_IMPORT_QUERY = `
(preproc_include path: (string_literal) @path)
`;

// ============================================================================
// Grammar loading
// ============================================================================

function findPackageFile(pkg: string, file: string): string {
  // DIFFLOUPE_WASM_DIR or a `wasm/` dir beside the bundle holds the grammars
  // flat (packaged build); otherwise search node_modules upward from this file.
  const __dirname = import.meta.dir;
  for (const flatDir of [process.env.DIFFLOUPE_WASM_DIR, join(__dirname, "wasm")]) {
    if (flatDir && existsSync(join(flatDir, file))) return join(flatDir, file);
  }
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "node_modules", pkg, file);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate ${pkg}/${file} in any parent node_modules of ${__dirname}`,
  );
}

const WASM_FILES: Record<LanguageId, [string, string]> = {
  typescript: ["tree-sitter-typescript", "tree-sitter-typescript.wasm"],
  tsx: ["tree-sitter-typescript", "tree-sitter-tsx.wasm"],
  cpp: ["tree-sitter-cpp", "tree-sitter-cpp.wasm"],
};

interface LoadedLanguage {
  language: Language;
  definitions: Query;
  imports: Query;
}

export class OutlineExtractor {
  private parser: Parser;
  private loaded = new Map<LanguageId, LoadedLanguage>();

  private constructor(parser: Parser) {
    this.parser = parser;
  }

  static async create(): Promise<OutlineExtractor> {
    await Parser.init({
      locateFile: (name: string) => findPackageFile("web-tree-sitter", name),
    });
    return new OutlineExtractor(new Parser());
  }

  private async load(id: LanguageId): Promise<LoadedLanguage> {
    const cached = this.loaded.get(id);
    if (cached) return cached;

    const [pkg, file] = WASM_FILES[id];
    const language = await Language.load(findPackageFile(pkg, file));
    const isCpp = id === "cpp";
    const entry: LoadedLanguage = {
      language,
      definitions: new Query(language, isCpp ? CPP_DEFINITION_QUERY : TS_DEFINITION_QUERY),
      imports: new Query(language, isCpp ? CPP_IMPORT_QUERY : TS_IMPORT_QUERY),
    };
    this.loaded.set(id, entry);
    return entry;
  }

  /** Preload grammars so later parseFile calls are synchronous-ish */
  async warmup(ids: LanguageId[]): Promise<void> {
    for (const id of ids) await this.load(id);
  }

  /**
   * Parse one file. `relPath` is the repo-relative path used for import resolution
   * and reported back in the outline.
   */
  async parseFile(absPath: string, relPath: string, repoRoot: string): Promise<FileOutline | null> {
    const language = detectLanguage(relPath);
    if (!language) return null;

    let source: string;
    try {
      source = readFileSync(absPath, "utf-8");
    } catch {
      return null;
    }

    return this.parseSource(source, relPath, repoRoot, language);
  }

  /**
   * Parse in-memory source. `files` resolves relative imports: a repo root on
   * disk, or the repo's file list when the source came from git objects.
   */
  async parseSource(
    source: string,
    relPath: string,
    files: SourceFiles,
    language?: LanguageId,
  ): Promise<FileOutline | null> {
    const raw = await this.parseRaw(source, relPath, language);
    return raw ? resolveOutline(raw, relPath, files) : null;
  }

  /** Parse without resolving imports: the result depends only on `source` and its language. */
  async parseRaw(source: string, relPath: string, language?: LanguageId): Promise<RawOutline | null> {
    const id = language ?? detectLanguage(relPath);
    if (!id) return null;

    const { language: lang, definitions, imports } = await this.load(id);
    this.parser.setLanguage(lang);
    const tree = this.parser.parse(source);
    if (!tree) return null;

    // The tree holds wasm heap memory that the JS garbage collector does not
    // manage, so a throw between here and delete() leaks it for the life of the
    // process. build-map.ts swallows per-file errors and keeps sweeping, which
    // is exactly the shape that turns one leak into thousands.
    try {
      const root = tree.rootNode;
      return {
        language: id,
        // Same rule as countLines in lib/io.ts: a trailing newline does not add
        // a line. The map feeds these counts to the model, and an inflated one
        // invites a citation past EOF that verification then throws away.
        lines: source.length === 0 ? 0 : source.replace(/\n$/, "").split("\n").length,
        symbols: collectSymbols(root, source, definitions, id),
        importSpecs: collectImportSpecs(root, imports),
        parseError: root.hasError,
      };
    } finally {
      tree.delete();
    }
  }
}

// ============================================================================
// Symbol collection
// ============================================================================

const CONTAINER_TYPES = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "class_specifier",
  "struct_specifier",
]);

const CPP_BODY_TYPES = new Set(["compound_statement"]);

/** Walking out of one of these means no object literal was in the way. */
const TS_SCOPE_BOUNDARIES = new Set(["class_body", "interface_body", "statement_block", "program"]);

const CPP_SIGNATURE_ANCESTORS = new Set([
  "field_declaration",
  "declaration",
  "function_definition",
  "template_declaration",
]);

interface TSNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  parent: TSNode | null;
  hasError: boolean;
  childForFieldName(name: string): TSNode | null;
}

function collectSymbols(
  root: unknown,
  source: string,
  query: Query,
  language: LanguageId,
): SymbolDef[] {
  const matches = query.matches(root as never);
  const seen = new Set<string>();
  const symbols: SymbolDef[] = [];

  for (const match of matches) {
    let nameNode: TSNode | null = null;
    let defNode: TSNode | null = null;
    let kind: SymbolKind | null = null;

    for (const capture of match.captures) {
      const node = capture.node as unknown as TSNode;
      if (capture.name === "name") nameNode = node;
      else if (capture.name.startsWith("definition.")) {
        defNode = node;
        kind = capture.name.slice("definition.".length) as SymbolKind;
      }
    }
    if (!nameNode || !defNode || !kind) continue;
    if (isObjectLiteralMember(defNode, language)) continue;

    const name = nameNode.text;
    const line = defNode.startPosition.row + 1;
    const key = `${kind}:${name}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const container = findContainer(defNode);
    symbols.push({
      name,
      kind,
      line,
      exported: isExported(defNode, language),
      ...(container ? { container } : {}),
      signature: signatureText(defNode, source, language),
    });
  }

  // A declarator bound to an arrow or function expression matches both the
  // specific pattern and the catch-all one, producing a `function` and a
  // `variable` for the same binding. `seen` cannot collapse them because it is
  // keyed on kind. The specific answer is the useful one, so the generic
  // duplicate is dropped here rather than by trying to express "not a function"
  // in the query, which tree-sitter has no clean way to say.
  const specific = new Set(
    symbols.filter((s) => s.kind !== "variable").map((s) => `${s.name}:${s.line}`),
  );
  const deduped = symbols.filter(
    (s) => s.kind !== "variable" || !specific.has(`${s.name}:${s.line}`),
  );

  deduped.sort((a, b) => a.line - b.line);
  return deduped;
}

/**
 * True for definitions written inside an object literal, such as the `computeResult`
 * methods passed to `new PromiseMap({...})`. Tree-sitter sees them as methods nested
 * in the enclosing class, but they are callback wiring, not part of that class's API.
 */
function isObjectLiteralMember(node: TSNode, language: LanguageId): boolean {
  if (language === "cpp") return false;
  let current = node.parent;
  while (current) {
    if (current.type === "object") return true;
    if (TS_SCOPE_BOUNDARIES.has(current.type)) return false;
    current = current.parent;
  }
  return false;
}

function findContainer(node: TSNode): string | undefined {
  let current = node.parent;
  while (current) {
    if (CONTAINER_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName("name");
      if (nameNode) return nameNode.text;
    }
    current = current.parent;
  }
  return undefined;
}

const TS_BODY_TYPES = new Set(["statement_block", "arrow_function", "function_expression"]);

function isExported(node: TSNode, language: LanguageId): boolean {
  let current: TSNode | null = node;
  while (current) {
    if (language === "cpp") {
      // A declaration buried in a function body is a local, not part of the API.
      if (CPP_BODY_TYPES.has(current.type) && current !== node) return false;
    } else {
      // Same rule for TS/JS, which otherwise walks straight past a function body
      // to the `export` on the enclosing declaration and marks every helper
      // closure inside an exported function as part of the file's API. Class and
      // interface bodies are deliberately not boundaries: a method of an
      // exported class is exported.
      if (TS_BODY_TYPES.has(current.type) && current !== node) return false;
      if (current.type === "export_statement") return true;
    }
    current = current.parent;
  }
  return language === "cpp";
}

function signatureText(node: TSNode, source: string, language: LanguageId): string {
  let target = node;

  if (language === "cpp" && node.type === "function_declarator") {
    let current = node.parent;
    while (current) {
      if (CPP_SIGNATURE_ANCESTORS.has(current.type)) {
        target = current;
        break;
      }
      current = current.parent;
    }
  }

  // `const fn = (x) => ...` is captured at the declarator, which drops the keyword
  // and leaves a bare `fn = (x) =>`. The parameter list lives in the arrow itself.
  if (target.type === "variable_declarator") {
    const keyword = target.parent?.text.trimStart().split(/\s/)[0] ?? "const";
    const value = target.childForFieldName("value");
    const arrowBody = value?.childForFieldName("body");
    const end =
      arrowBody && arrowBody.startIndex > target.startIndex
        ? arrowBody.startIndex
        : target.endIndex;
    return collapse(`${keyword} ${source.slice(target.startIndex, end)}`);
  }

  const body = target.childForFieldName("body");
  const end = body && body.startIndex > target.startIndex ? body.startIndex : target.endIndex;
  const raw = source.slice(target.startIndex, end);
  return collapse(raw);
}

function collapse(text: string, max = 160): string {
  // Line comments have to go before newlines do, or `//` eats the rest of the
  // signature. Multi-line type aliases are otherwise mostly prose.
  const flat = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n")
    .replace(/\s+/g, " ")
    .replace(/[{;,]\s*$/, "")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ============================================================================
// Import collection
// ============================================================================

const TS_RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

function collectImportSpecs(root: unknown, query: Query): string[] {
  const specs = new Set<string>();
  for (const match of query.matches(root as never)) {
    for (const capture of match.captures) {
      if (capture.name !== "path") continue;
      const spec = (capture.node as unknown as TSNode).text.replace(/^["'<]|["'>]$/g, "");
      if (spec) specs.add(spec);
    }
  }
  return [...specs];
}

/**
 * Resolve a raw outline's import specifiers against the repository's files.
 * Kept apart from parsing because the parse depends only on the file's content,
 * while what an import resolves to depends on which other files exist.
 */
export function resolveOutline(raw: RawOutline, relPath: string, files: SourceFiles): FileOutline {
  const resolved = new Set<string>();
  const external = new Set<string>();
  const fromDir = posix.dirname(relPath.replace(/\\/g, "/"));
  for (const spec of raw.importSpecs) {
    const target =
      raw.language === "cpp" ? resolveInclude(spec, fromDir, files) : resolveTsImport(spec, fromDir, files);
    if (target) resolved.add(target);
    else external.add(spec);
  }
  return {
    path: relPath,
    language: raw.language,
    lines: raw.lines,
    symbols: raw.symbols,
    imports: [...resolved].sort(),
    externalImports: [...external].sort(),
    parseError: raw.parseError,
  };
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The repo-relative path `rel` when it names a file inside the repo, else null.
 * A path that climbs out of the root is rejected rather than reported as a
 * nonsense suffix.
 */
function fileAt(files: SourceFiles, rel: string): string | null {
  const norm = posix.normalize(rel.replace(/\\/g, "/"));
  if (norm === ".." || norm.startsWith("../") || posix.isAbsolute(norm)) return null;
  if (typeof files === "string") return isFile(join(files, norm)) ? norm : null;
  return files.has(norm) ? norm : null;
}

function resolveTsImport(spec: string, fromDir: string, files: SourceFiles): string | null {
  if (!spec.startsWith(".")) return null;
  const base = posix.join(fromDir, spec);
  for (const suffix of TS_RESOLVE_SUFFIXES) {
    // The empty suffix is the specifier as written, which is how every import in
    // this directory is written (`./lib/proc.ts`). It has to be checked as a
    // file rather than merely existing: `./lib` names a directory, and treating
    // that as the resolution would attribute the edge to the folder.
    const hit = fileAt(files, `${base}${suffix}`);
    if (hit) return hit;
  }
  return null;
}

function resolveInclude(spec: string, fromDir: string, files: SourceFiles): string | null {
  if (spec.startsWith("/")) return null;
  // Includes are written against the compiler's -I roots, not just the including
  // file's directory: with `src/native` on the path, `src/native/driver/Driver.h`
  // says `#include "shared/Utils.h"`. Trying only the file's own directory and
  // the repo root resolves neither, and in a large C++ tree those are the
  // majority — measured at 481 unresolved against 410 resolved. Every ancestor directory
  // covers any -I root without naming one, since a root is always an ancestor of
  // the files compiled with it.
  let dir = fromDir;
  for (;;) {
    const hit = fileAt(files, posix.join(dir, spec));
    if (hit) return hit;
    const up = posix.dirname(dir);
    if (up === dir || dir === "." || dir === "") break;
    dir = up;
  }
  return fileAt(files, spec);
}
