/**
 * DiffFile - Renders a single file's diff with header and hunks.
 */

import type { DiffFile as DiffFileType } from "../../../types/diff.js";
import { DiffHunk } from "./DiffHunk.js";
import styles from "./DiffFile.module.css";

export interface DiffFileProps {
  file: DiffFileType;
}

/** Calculate line count stats for a file */
function getFileStats(file: DiffFileType): { added: number; deleted: number } {
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

export function DiffFile({ file }: DiffFileProps) {
  const stats = getFileStats(file);
  const displayPath =
    file.status === "renamed" && file.oldPath
      ? `${file.oldPath} -> ${file.path}`
      : file.path;

  return (
    <div className={styles.file}>
      <div className={styles.header}>
        <span className={styles.status} data-status={file.status}>
          {file.status}
        </span>
        <span className={styles.path}>{displayPath}</span>
        <span className={styles.stats}>
          {stats.added > 0 && (
            <span className={styles.added}>+{stats.added}</span>
          )}
          {stats.deleted > 0 && (
            <span className={styles.deleted}>-{stats.deleted}</span>
          )}
        </span>
      </div>

      {file.isBinary ? (
        <div className={styles.binary}>Binary file not shown</div>
      ) : (
        <div className={styles.hunks}>
          {file.hunks.map((hunk, idx) => (
            <DiffHunk key={idx} hunk={hunk} filePath={file.path} />
          ))}
        </div>
      )}
    </div>
  );
}
