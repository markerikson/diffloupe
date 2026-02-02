/**
 * DiffLine - Renders a single line of a diff hunk.
 * Shows line numbers, prefix (+/-/space), and syntax-highlighted content.
 */

import type { DiffLine as DiffLineType } from "../../../types/diff.js";
import { useHighlighter } from "../../contexts/HighlighterContext.js";
import styles from "./DiffLine.module.css";

export interface DiffLineProps {
  line: DiffLineType;
  filePath: string;
}

export function DiffLine({ line, filePath }: DiffLineProps) {
  const { getHighlightedLine } = useHighlighter();

  const prefix = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
  const highlightedContent = getHighlightedLine(filePath, line.content);

  return (
    <div className={styles.line} data-type={line.type}>
      <span className={styles.lineNumber} data-side="old">
        {line.oldLineNumber ?? ""}
      </span>
      <span className={styles.lineNumber} data-side="new">
        {line.newLineNumber ?? ""}
      </span>
      <span className={styles.prefix}>{prefix}</span>
      <span
        className={styles.content}
        dangerouslySetInnerHTML={{ __html: highlightedContent }}
      />
    </div>
  );
}
