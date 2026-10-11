/**
 * Per-file facts about a diff that `grouping.ts` links files with: what each
 * changed file imports, which names it defines on added lines, and which
 * identifiers its added lines use.
 *
 * Only the changed files are parsed, so this costs a fraction of the repo map.
 * Files tree-sitter cannot parse still get their used identifiers, which is
 * enough to link a YAML or JSON file to nothing, and that is correct.
 */
import type { FileFacts } from "./grouping.ts";
import { diffLines, parseDiffHunks } from "./hunks.ts";
import { detectLanguage } from "./languages.ts";
import { resolveOutlineImports, type OutlineImports, type ProjectFiles } from "./module-resolver.ts";

export async function gatherChangeFacts(o: {
  /** The head version of the repo: its file list, and a reader for the changed files and config files. */
  source: ProjectFiles;
  /** `git diff --unified=0` output for the files to group. */
  diffU0: string;
  files: string[];
  fileTokens: Map<string, number>;
}): Promise<FileFacts[]> {
  const hunks = parseDiffHunks(o.diffU0);
  const used = new Map<string, Set<string>>();
  for (const { file, line } of diffLines(o.diffU0)) {
    if (!file || !line.startsWith("+") || line.startsWith("+++ ")) continue;
    const set = used.get(file) ?? new Set<string>();
    for (const m of line.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) set.add(m[0]);
    used.set(file, set);
  }

  const { OutlineExtractor } = await import("./code-outline.ts");
  const extractor = await OutlineExtractor.create();
  const parsed: { file: string; imports: OutlineImports; defined: string[] }[] = [];
  for (const file of o.files) {
    const imports: OutlineImports = { path: file, imports: [], externalImports: [] };
    let defined: string[] = [];
    if (detectLanguage(file)) {
      try {
        const text = o.source.read(file);
        const outline = text === undefined ? null : await extractor.parseSource(text, file, o.source.paths);
        if (outline) {
          const added = hunks.get(file) ?? [];
          imports.imports = outline.imports;
          imports.externalImports = outline.externalImports;
          defined = outline.symbols
            .filter((s) => added.some((r) => s.line >= r.start && s.line <= r.end))
            .map((s) => s.name);
        }
      } catch {
        // An unparseable file still groups by directory and by its used names.
      }
    }
    parsed.push({ file, imports, defined });
  }
  resolveOutlineImports(
    parsed.map((p) => p.imports),
    o.source,
  );
  return parsed.map(({ file, imports, defined }) => ({
    file,
    tokens: o.fileTokens.get(file) ?? 0,
    imports: imports.imports,
    defined: [...new Set(defined)],
    used: [...(used.get(file) ?? [])],
  }));
}
