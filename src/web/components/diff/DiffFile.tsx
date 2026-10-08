/**
 * DiffFile - Renders a single file's diff with header and hunks.
 */

import { useState } from "react";
import type { DiffFile as DiffFileType } from "../../../types/diff.js";
import { DiffHunk } from "./DiffHunk.js";
import { getFileStats, filePathToId } from "../../utils/diffStats.js";
import styles from "./DiffFile.module.css";

export interface DiffFileProps {
  file: DiffFileType;
}

export function DiffFile({ file }: DiffFileProps) {
  const [expanded, setExpanded] = useState(true);
  const stats = getFileStats(file);
  const displayPath =
    file.status === "renamed" && file.oldPath
      ? `${file.oldPath} -> ${file.path}`
      : file.path;

  return (
    <div className={styles.file} id={filePathToId(file.path)}>
      <div
        className={styles.header}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className={styles.chevron}>{expanded ? "▼" : "▶"}</span>
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

      {expanded &&
        (file.isBinary ? (
          <div className={styles.binary}>Binary file not shown</div>
        ) : (
          <div className={styles.hunks}>
            {file.hunks.map((hunk, idx) => (
              <DiffHunk key={idx} hunk={hunk} filePath={file.path} />
            ))}
          </div>
        ))}
    </div>
  );
}
