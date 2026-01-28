import type {
  ParsedDiff,
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffFileStatus,
  DiffLineType,
} from "../types/diff.js";

/**
 * Parse a raw unified diff string into structured data
 */
export function parseDiff(rawDiff: string): ParsedDiff {
  if (!rawDiff || rawDiff.trim().length === 0) {
    return { files: [] };
  }

  const files: DiffFile[] = [];
  const lines = rawDiff.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Look for diff header: diff --git a/path b/path
    if (line?.startsWith("diff --git ")) {
      const { file, nextIndex } = parseFile(lines, i);
      files.push(file);
      i = nextIndex;
    } else {
      i++;
    }
  }

  return { files };
}

/**
 * Parse a single file's diff starting at the given index
 */
function parseFile(
  lines: string[],
  startIndex: number
): { file: DiffFile; nextIndex: number } {
  let i = startIndex;

  // Parse the diff --git line to get paths
  const diffLine = lines[i];
  if (!diffLine) {
    throw new Error(`Expected diff line at index ${i}`);
  }
  const { path, oldPath: gitOldPath } = parseGitDiffLine(diffLine);
  i++;

  let oldPath: string | undefined;
  let status: DiffFileStatus = "modified";
  let isBinary = false;
  const hunks: DiffHunk[] = [];

  // Process header lines until we hit a hunk or next file
  while (i < lines.length) {
    const line = lines[i];
    if (!line || line.startsWith("diff --git ")) {
      break;
    }

    // Check for new file mode
    if (line.startsWith("new file mode")) {
      status = "added";
      i++;
      continue;
    }

    // Check for deleted file mode
    if (line.startsWith("deleted file mode")) {
      status = "deleted";
      i++;
      continue;
    }

    // Check for rename
    if (line.startsWith("rename from ")) {
      oldPath = line.slice(12);
      status = "renamed";
      i++;
      continue;
    }

    if (line.startsWith("rename to ")) {
      // Already captured the rename status from "rename from"
      i++;
      continue;
    }

    // Check for similarity index (renames)
    if (line.startsWith("similarity index ")) {
      i++;
      continue;
    }

    // Check for binary file
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      isBinary = true;
      i++;
      // Skip binary content until next file
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine?.startsWith("diff --git ")) {
          break;
        }
        i++;
      }
      break;
    }

    // Check for hunk header
    if (line.startsWith("@@")) {
      const { hunk, nextIndex } = parseHunk(lines, i);
      hunks.push(hunk);
      i = nextIndex;
      continue;
    }

    // Skip other header lines (index, ---, +++, etc.)
    i++;
  }

  // For renames detected via git diff line but not explicitly marked
  if (!oldPath && gitOldPath && gitOldPath !== path) {
    oldPath = gitOldPath;
    if (status === "modified") {
      status = "renamed";
    }
  }

  const file: DiffFile = {
    path,
    status,
    hunks,
    isBinary,
  };

  if (oldPath !== undefined) {
    file.oldPath = oldPath;
  }

  return {
    file,
    nextIndex: i,
  };
}

/**
 * Parse the "diff --git a/path b/path" line
 */
function parseGitDiffLine(line: string): { path: string; oldPath: string | undefined } {
  // Format: diff --git a/old/path b/new/path
  // The paths are prefixed with a/ and b/
  // Edge case: paths with spaces or special chars

  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (match) {
    const matchedOldPath = match[1];
    const matchedNewPath = match[2];
    if (matchedOldPath && matchedNewPath) {
      return {
        path: matchedNewPath,
        oldPath: matchedOldPath !== matchedNewPath ? matchedOldPath : undefined,
      };
    }
  }

  // Fallback: try to extract something reasonable
  // This handles edge cases like quoted paths
  const content = line.slice(11); // Remove "diff --git "
  const parts = content.split(" b/");
  const firstPart = parts[0];
  const secondPart = parts[1];

  if (firstPart && secondPart) {
    const extractedOldPath = firstPart.startsWith("a/") ? firstPart.slice(2) : firstPart;
    return {
      path: secondPart,
      oldPath: extractedOldPath !== secondPart ? extractedOldPath : undefined,
    };
  }

  // Last resort: just take what we can get
  return { path: content, oldPath: undefined };
}

/**
 * Parse a hunk starting at the @@ line
 */
function parseHunk(
  lines: string[],
  startIndex: number
): { hunk: DiffHunk; nextIndex: number } {
  const headerLine = lines[startIndex];
  if (!headerLine) {
    throw new Error(`Expected hunk header at index ${startIndex}`);
  }

  // Parse: @@ -oldStart,oldLines +newStart,newLines @@ optional context
  const match = headerLine.match(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  );

  if (!match) {
    throw new Error(`Invalid hunk header: ${headerLine}`);
  }

  const oldStartStr = match[1];
  const oldLinesStr = match[2];
  const newStartStr = match[3];
  const newLinesStr = match[4];

  if (!oldStartStr || !newStartStr) {
    throw new Error(`Invalid hunk header numbers: ${headerLine}`);
  }

  const oldStart = parseInt(oldStartStr, 10);
  const oldLines = oldLinesStr !== undefined ? parseInt(oldLinesStr, 10) : 1;
  const newStart = parseInt(newStartStr, 10);
  const newLines = newLinesStr !== undefined ? parseInt(newLinesStr, 10) : 1;

  const hunkLines: DiffLine[] = [];
  let i = startIndex + 1;

  // Track line numbers as we go
  let currentOldLine = oldStart;
  let currentNewLine = newStart;

  while (i < lines.length) {
    const line = lines[i];

    // Handle undefined (end of array)
    if (line === undefined) {
      break;
    }

    // Stop at next hunk or next file
    if (line.startsWith("diff --git ") || line.startsWith("@@")) {
      break;
    }

    // Handle "\ No newline at end of file" marker
    if (line.startsWith("\\")) {
      i++;
      continue;
    }

    // Skip trailing empty line at end of diff
    // (Empty context lines in the middle of a hunk start with a space)
    if (line === "" && i === lines.length - 1) {
      break;
    }

    const firstChar = line[0];
    const content = line.slice(1);

    let type: DiffLineType;
    let oldLineNumber: number | undefined;
    let newLineNumber: number | undefined;

    if (firstChar === "+") {
      type = "add";
      newLineNumber = currentNewLine;
      currentNewLine++;
    } else if (firstChar === "-") {
      type = "delete";
      oldLineNumber = currentOldLine;
      currentOldLine++;
    } else if (firstChar === " " || firstChar === undefined) {
      // Context line (space prefix) or empty line
      type = "context";
      oldLineNumber = currentOldLine;
      newLineNumber = currentNewLine;
      currentOldLine++;
      currentNewLine++;
    } else {
      // Unknown line type - might be end of hunk
      // Check if this looks like it could be a header line we should stop at
      if (
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file")
      ) {
        break;
      }
      // Otherwise treat as context (shouldn't happen in well-formed diffs)
      type = "context";
      oldLineNumber = currentOldLine;
      newLineNumber = currentNewLine;
      currentOldLine++;
      currentNewLine++;
    }

    hunkLines.push({
      type,
      content,
      oldLineNumber,
      newLineNumber,
    });

    i++;
  }

  return {
    hunk: {
      oldStart,
      oldLines,
      newStart,
      newLines,
      header: headerLine,
      lines: hunkLines,
    },
    nextIndex: i,
  };
}
