/**
 * Source-language detection by extension.
 *
 * Split out of code-outline.ts so callers that only need to tell source from
 * everything else do not pull in web-tree-sitter.
 */
import { extname } from "node:path";

export type LanguageId = "typescript" | "tsx" | "cpp";

const EXT_LANGUAGE: Record<string, LanguageId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "tsx",
  ".jsx": "tsx",
  ".mjs": "tsx",
  ".cjs": "tsx",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".c": "cpp",
  ".h": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
};

export function detectLanguage(path: string): LanguageId | null {
  return EXT_LANGUAGE[extname(path).toLowerCase()] ?? null;
}
