/** Status of a file in the diff */
export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

/** Type of a diff line */
export type DiffLineType = "context" | "add" | "delete";

/** A single line in a diff hunk */
export interface DiffLine {
  type: DiffLineType;
  /** The line content (without the leading +/-/space) */
  content: string;
  /** Line number in the old file (undefined for added lines) */
  oldLineNumber: number | undefined;
  /** Line number in the new file (undefined for deleted lines) */
  newLineNumber: number | undefined;
}

/** A hunk represents a contiguous block of changes */
export interface DiffHunk {
  /** Starting line in old file */
  oldStart: number;
  /** Number of lines from old file */
  oldLines: number;
  /** Starting line in new file */
  newStart: number;
  /** Number of lines in new file */
  newLines: number;
  /** The raw @@ header line */
  header: string;
  /** The lines in this hunk */
  lines: DiffLine[];
}

/** A file that has changes */
export interface DiffFile {
  /** Current path of the file */
  path: string;
  /** Previous path (only for renames) */
  oldPath?: string;
  /** What happened to this file */
  status: DiffFileStatus;
  /** The hunks of changes (empty for binary files) */
  hunks: DiffHunk[];
  /** True if this is a binary file */
  isBinary: boolean;
}

/** The result of parsing a diff */
export interface ParsedDiff {
  files: DiffFile[];
}
