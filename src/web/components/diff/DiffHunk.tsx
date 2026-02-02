/**
 * DiffHunk - Renders a single hunk (contiguous block of changes) in a diff.
 */

import type { DiffHunk as DiffHunkType } from "../../../types/diff.js";
import { DiffLine } from "./DiffLine.js";
import styles from "./DiffHunk.module.css";

export interface DiffHunkProps {
  hunk: DiffHunkType;
  filePath: string;
}

export function DiffHunk({ hunk, filePath }: DiffHunkProps) {
  return (
    <div className={styles.hunk}>
      <div className={styles.header}>{hunk.header}</div>
      <div className={styles.lines}>
        {hunk.lines.map((line, idx) => (
          <DiffLine key={idx} line={line} filePath={filePath} />
        ))}
      </div>
    </div>
  );
}
