/**
 * Repository Context - Add file tree awareness to diff analysis
 *
 * When analyzing diffs, the LLM can't see files outside the diff. This causes
 * false positives like "import to missing file" when the file exists but isn't
 * in the diff hunks.
 *
 * This module provides context about files in directories touched by the diff,
 * so the LLM knows what else exists nearby.
 */

import simpleGit from "simple-git";
import { dirname, join } from "path";
import { readFile } from "fs/promises";
import type { ParsedDiff } from "../types/diff.js";

/** Status of a sibling file in the repository */
export type SiblingFileStatus = "existing" | "new" | "modified" | "deleted";

/** A file in a directory touched by the diff */
export interface SiblingFile {
  path: string;
  status: SiblingFileStatus;
}

/** Content of a new file for context inclusion */
export interface FileContent {
  path: string;
  content: string;
  lineCount: number;
  truncated: boolean;
}

/**
 * Extract unique directories from diff file paths.
 *
 * For each file in the diff, we get its parent directory. This tells us
 * which parts of the repo are being touched.
 */
export function getChangedDirectories(diff: ParsedDiff): string[] {
  const dirs = new Set<string>();

  for (const file of diff.files) {
    const dir = dirname(file.path);
    if (dir && dir !== ".") {
      dirs.add(dir);
    }
    // Also include old path for renames
    if (file.oldPath) {
      const oldDir = dirname(file.oldPath);
      if (oldDir && oldDir !== ".") {
        dirs.add(oldDir);
      }
    }
  }

  return [...dirs].sort();
}

/**
 * List files in the given directories that exist in git.
 *
 * Uses `git ls-files` to get tracked files, and `git status --porcelain`
 * to identify new/modified/deleted files.
 *
 * @param directories - Directories to list files from
 * @param cwd - Working directory (defaults to process.cwd())
 */
export async function getSiblingFiles(
  directories: string[],
  cwd?: string
): Promise<SiblingFile[]> {
  if (directories.length === 0) {
    return [];
  }

  const git = simpleGit(cwd);

  // Get all tracked files
  const trackedOutput = await git.raw(["ls-files"]);
  const trackedFiles = trackedOutput.split("\n").filter(Boolean);
  // Note: trackedSet could be used for O(1) lookups if needed later

  // Get staged/unstaged status
  const statusOutput = await git.raw(["status", "--porcelain"]);
  const statusLines = statusOutput.split("\n").filter(Boolean);

  // Parse status: first two chars are index/worktree status
  const newFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  const deletedFiles = new Set<string>();

  for (const line of statusLines) {
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    const filePath = line.slice(3); // Skip "XY " prefix

    // New files: A (added) in index, or ? (untracked)
    if (indexStatus === "A" || indexStatus === "?") {
      newFiles.add(filePath);
    }
    // Modified files: M in either index or worktree
    else if (indexStatus === "M" || worktreeStatus === "M") {
      modifiedFiles.add(filePath);
    }
    // Deleted files: D in either index or worktree
    else if (indexStatus === "D" || worktreeStatus === "D") {
      deletedFiles.add(filePath);
    }
  }

  // Collect all files in target directories
  const dirSet = new Set(directories);
  const allFiles = new Set<string>();

  // Add tracked files in target dirs
  for (const file of trackedFiles) {
    if (dirSet.has(dirname(file))) {
      allFiles.add(file);
    }
  }

  // Add new/staged files in target dirs (may not be tracked yet)
  for (const file of newFiles) {
    if (dirSet.has(dirname(file))) {
      allFiles.add(file);
    }
  }

  // Build result with status
  const result: SiblingFile[] = [];
  for (const path of [...allFiles].sort()) {
    let status: SiblingFileStatus;
    if (newFiles.has(path)) {
      status = "new";
    } else if (deletedFiles.has(path)) {
      status = "deleted";
    } else if (modifiedFiles.has(path)) {
      status = "modified";
    } else {
      status = "existing";
    }
    result.push({ path, status });
  }

  return result;
}

/** Maximum lines per file to include in context */
const MAX_LINES_PER_FILE = 500;

/** Maximum total lines across all new files */
const MAX_TOTAL_LINES = 2000;

/**
 * Read contents of new files for inclusion in context.
 *
 * New files (staged additions) are loaded so the LLM can verify imports
 * resolve to real implementations. Files are truncated if too large.
 *
 * @param newFiles - Paths of new files to read
 * @param cwd - Working directory (defaults to process.cwd())
 */
export async function getNewFileContents(
  newFiles: string[],
  cwd?: string
): Promise<FileContent[]> {
  if (newFiles.length === 0) {
    return [];
  }

  const workDir = cwd || process.cwd();
  const results: FileContent[] = [];
  let totalLines = 0;

  // Read files sequentially to respect budget limit - each file may consume remaining budget
  // eslint-disable-next-line no-await-in-loop
  for (const filePath of newFiles) {
    // Stop if we've hit the total limit
    if (totalLines >= MAX_TOTAL_LINES) {
      break;
    }

    try {
      const fullPath = join(workDir, filePath);
      const content = await readFile(fullPath, "utf-8");
      const lines = content.split("\n");
      const lineCount = lines.length;

      // Truncate if file is too large
      const remainingBudget = MAX_TOTAL_LINES - totalLines;
      const maxLines = Math.min(MAX_LINES_PER_FILE, remainingBudget);
      const truncated = lineCount > maxLines;

      const finalContent = truncated
        ? lines.slice(0, maxLines).join("\n") + "\n// ... truncated"
        : content;

      results.push({
        path: filePath,
        content: finalContent,
        lineCount: truncated ? maxLines : lineCount,
        truncated,
      });

      totalLines += truncated ? maxLines : lineCount;
    } catch {
      // Skip files that can't be read (deleted, permissions, etc.)
    }
  }

  return results;
}

/**
 * Format new file contents into a context section for prompts.
 *
 * @example
 * ```
 * ## New Files (Full Source)
 *
 * ### src/services/context.ts
 * ```typescript
 * // file contents here
 * ```
 * ```
 */
export function formatNewFilesSection(files: FileContent[]): string {
  if (files.length === 0) {
    return "";
  }

  const lines: string[] = ["## New Files (Full Source)", ""];

  for (const file of files) {
    const ext = file.path.split(".").pop() || "";
    const lang = getLanguageFromExtension(ext);
    const truncatedNote = file.truncated ? ` (truncated, ${file.lineCount} lines shown)` : "";

    lines.push(`### ${file.path}${truncatedNote}`);
    lines.push("```" + lang);
    lines.push(file.content);
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function getLanguageFromExtension(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    rb: "ruby",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    sql: "sql",
    sh: "bash",
    bash: "bash",
  };
  return map[ext] || "";
}

/**
 * Format sibling files into a context section for prompts.
 *
 * Groups files by directory and marks status with arrows.
 *
 * @example
 * ```
 * ## Repository Context
 * Files in directories touched by this diff:
 *
 * src/prompts/
 * - alignment.ts ← NEW
 * - intent.ts
 * - risks.ts
 * ```
 */
export function formatContextSection(siblings: SiblingFile[]): string {
  if (siblings.length === 0) {
    return "";
  }

  // Group by directory
  const byDir = new Map<string, SiblingFile[]>();
  for (const file of siblings) {
    const dir = dirname(file.path);
    const existing = byDir.get(dir);
    if (existing) {
      existing.push(file);
    } else {
      byDir.set(dir, [file]);
    }
  }

  const lines: string[] = [
    "## Repository Context",
    "Files in directories touched by this diff:",
    "",
  ];

  // Sort directories
  const sortedDirs = [...byDir.keys()].sort();

  for (const dir of sortedDirs) {
    lines.push(`${dir}/`);
    const files = byDir.get(dir) ?? [];
    // Sort files within directory
    files.sort((a, b) => a.path.localeCompare(b.path));
    for (const file of files) {
      const filename = file.path.split("/").pop() || file.path;
      const statusLabel = getStatusLabel(file.status);
      lines.push(`- ${filename}${statusLabel}`);
    }
    lines.push(""); // blank line between directories
  }

  return lines.join("\n");
}

function getStatusLabel(status: SiblingFileStatus): string {
  switch (status) {
    case "new":
      return " ← NEW";
    case "modified":
      return " ← MODIFIED";
    case "deleted":
      return " ← DELETED";
    case "existing":
      return "";
  }
}

/**
 * Gather repository context for a diff.
 *
 * This is the main entry point - given a diff, returns formatted context
 * showing what files exist in the touched directories, plus full source
 * of new files.
 *
 * @param diff - The parsed diff to gather context for
 * @param cwd - Working directory (defaults to process.cwd())
 */
export async function gatherContext(
  diff: ParsedDiff,
  cwd?: string
): Promise<string> {
  const directories = getChangedDirectories(diff);
  const siblings = await getSiblingFiles(directories, cwd);

  // Collect new file paths from siblings
  const newFilePaths = siblings
    .filter((s) => s.status === "new")
    .map((s) => s.path);

  // Load new file contents
  const newFileContents = await getNewFileContents(newFilePaths, cwd);

  // Build context: sibling listing + new file source
  const sections: string[] = [];

  const siblingSection = formatContextSection(siblings);
  if (siblingSection) {
    sections.push(siblingSection);
  }

  const newFilesSection = formatNewFilesSection(newFileContents);
  if (newFilesSection) {
    sections.push(newFilesSection);
  }

  return sections.join("\n");
}
