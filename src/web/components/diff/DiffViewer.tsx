/**
 * DiffViewer - Container component that renders all files in a parsed diff.
 */

import type { ParsedDiff } from "../../../types/diff.js";
import { DiffFile } from "./DiffFile.js";
import { useHighlighter } from "../../contexts/HighlighterContext.js";
import styles from "./DiffViewer.module.css";

export interface DiffViewerProps {
  diff: ParsedDiff;
}

export function DiffViewer({ diff }: DiffViewerProps) {
  const { isReady } = useHighlighter();

  if (!isReady) {
    return (
      <div className={styles.loading}>
        <span>Initializing syntax highlighter...</span>
      </div>
    );
  }

  if (diff.files.length === 0) {
    return (
      <div className={styles.empty}>
        <span>No files changed</span>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {diff.files.map((file) => (
        <DiffFile key={file.path} file={file} />
      ))}
    </div>
  );
}
