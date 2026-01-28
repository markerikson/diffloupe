/**
 * Deleted File Summarization
 *
 * When files >100 lines are deleted, show a summary (header + signatures)
 * instead of full content. This reduces token usage for large migrations
 * while preserving useful context.
 *
 * ## Why Summarize?
 *
 * A 500-line deleted file contributes ~2000 tokens showing every removed line,
 * but the key information is much simpler: "this file was deleted, it contained
 * these functions/classes."
 *
 * ## Output Format
 *
 * ```
 * DELETED FILE: src/features/auth/AuthSlice.ts (287 lines)
 *
 * First 15 lines (header/imports):
 * ```typescript
 * import { createSlice } from '@reduxjs/toolkit'
 * import type { AuthState } from './types'
 * // ...
 * ```
 *
 * Extracted signatures:
 * - createSlice({ name: 'auth', ... })
 * - function validateToken(token: string): boolean
 * - interface AuthState { ... }
 * ```
 */

import type { DiffFile } from "../types/diff.js";

export interface DeletedFileSummary {
  /** First N lines of the file (captures imports, comments, initial declarations) */
  headerLines: string[];
  /** Extracted function/class/export signatures */
  signatures: string[];
  /** Total number of lines that were deleted */
  totalLines: number;
}

/** Threshold: files larger than this get summarized */
const SUMMARY_THRESHOLD_LINES = 100;

/** Number of header lines to include in summary */
const HEADER_LINE_COUNT = 15;

/**
 * Check if a deleted file should be summarized instead of shown in full.
 *
 * Only deleted files over 100 lines are summarized. Smaller deletions
 * are shown in full (current behavior).
 */
export function shouldSummarizeDeletedFile(file: DiffFile): boolean {
  if (file.status !== "deleted") return false;

  const deletedLineCount = file.hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((l) => l.type === "delete").length,
    0
  );

  return deletedLineCount > SUMMARY_THRESHOLD_LINES;
}

/**
 * Extract function/class/export signatures from file content using regex.
 *
 * This is a "quick & dirty" approach that handles common cases for
 * TypeScript/JavaScript files. Can be upgraded to use ast-grep later
 * if more accuracy is needed.
 *
 * Extracts:
 * - Class declarations (including exported, abstract)
 * - Function declarations (including exported, async)
 * - Arrow function exports (export const foo = ...)
 * - Interface declarations
 * - Type alias declarations
 * - Named exports (export { foo, bar })
 *
 * @param content - The full file content as a string
 * @param ext - File extension (e.g., ".ts", ".js", ".py") - for future use
 */
export function extractSignatures(content: string, ext: string): string[] {
  const signatures: string[] = [];

  // TypeScript/JavaScript patterns
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    // Classes (including exported, default, abstract)
    const classMatches = content.matchAll(
      /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/gm
    );
    for (const m of classMatches) {
      signatures.push(`class ${m[1]}`);
    }

    // Functions (including exported, async, default)
    const funcMatches = content.matchAll(
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/gm
    );
    for (const m of funcMatches) {
      signatures.push(`function ${m[1]}()`);
    }

    // Arrow function exports: export const foo = (async arrow functions too)
    const arrowMatches = content.matchAll(
      /^export\s+const\s+(\w+)\s*=/gm
    );
    for (const m of arrowMatches) {
      signatures.push(`const ${m[1]}`);
    }

    // Interfaces
    const interfaceMatches = content.matchAll(
      /^(?:export\s+)?interface\s+(\w+)/gm
    );
    for (const m of interfaceMatches) {
      signatures.push(`interface ${m[1]}`);
    }

    // Type aliases
    const typeMatches = content.matchAll(
      /^(?:export\s+)?type\s+(\w+)\s*=/gm
    );
    for (const m of typeMatches) {
      signatures.push(`type ${m[1]}`);
    }

    // Named exports: export { foo, bar }
    const namedExportMatches = content.matchAll(
      /^export\s+\{([^}]+)\}/gm
    );
    for (const m of namedExportMatches) {
      const exportList = m[1];
      if (exportList) {
        const names = exportList
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim())
          .filter(Boolean);
        if (names.length > 0) {
          signatures.push(`export { ${names.join(", ")} }`);
        }
      }
    }
  }

  // Python patterns
  if (ext === ".py") {
    // Classes
    const pyClassMatches = content.matchAll(/^class\s+(\w+)/gm);
    for (const m of pyClassMatches) {
      signatures.push(`class ${m[1]}`);
    }

    // Functions (including async def)
    const pyFuncMatches = content.matchAll(/^(?:async\s+)?def\s+(\w+)/gm);
    for (const m of pyFuncMatches) {
      signatures.push(`def ${m[1]}()`);
    }
  }

  return signatures;
}

/**
 * Summarize a deleted file for inclusion in prompts.
 *
 * Extracts:
 * 1. First 15 lines (header/imports)
 * 2. Function/class/export signatures
 * 3. Total line count
 */
export function summarizeDeletedFile(file: DiffFile): DeletedFileSummary {
  // Extract all deleted lines (without the leading "-")
  const allLines = file.hunks.flatMap((hunk) =>
    hunk.lines.filter((l) => l.type === "delete").map((l) => l.content)
  );

  // Get file extension for signature extraction
  const ext = getFileExtension(file.path);

  return {
    headerLines: allLines.slice(0, HEADER_LINE_COUNT),
    signatures: extractSignatures(allLines.join("\n"), ext),
    totalLines: allLines.length,
  };
}

/**
 * Format a summarized deleted file for inclusion in prompts.
 *
 * Output format:
 * ```
 * DELETED FILE: path/to/file.ts (287 lines)
 *
 * First 15 lines (header/imports):
 * ```typescript
 * import ...
 * ```
 *
 * Extracted signatures:
 * - class Foo
 * - function bar()
 * ```
 */
export function formatDeletedFileSummary(
  file: DiffFile,
  summary: DeletedFileSummary
): string {
  const ext = getFileExtension(file.path);
  const langHint = getLanguageHint(ext);

  const lines: string[] = [
    `DELETED FILE: ${file.path} (${summary.totalLines} lines)`,
    "",
    `First ${summary.headerLines.length} lines (header/imports):`,
    "```" + langHint,
    ...summary.headerLines,
    "```",
  ];

  if (summary.signatures.length > 0) {
    lines.push("");
    lines.push("Extracted signatures:");
    for (const sig of summary.signatures) {
      lines.push(`- ${sig}`);
    }
  }

  return lines.join("\n");
}

/**
 * Get file extension from path (lowercase, with dot).
 */
function getFileExtension(path: string): string {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return "";
  return path.slice(lastDot).toLowerCase();
}

/**
 * Get language hint for code block based on extension.
 */
function getLanguageHint(ext: string): string {
  const hints: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".rb": "ruby",
    ".css": "css",
    ".scss": "scss",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".md": "markdown",
  };
  return hints[ext] || "";
}
