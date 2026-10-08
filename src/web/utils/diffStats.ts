import type { DiffFile } from "../../types/diff.js";

export function getFileStats(file: DiffFile): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;

  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") added++;
      if (line.type === "delete") deleted++;
    }
  }

  return { added, deleted };
}

export function filePathToId(path: string): string {
  return `diff-file-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;
}
