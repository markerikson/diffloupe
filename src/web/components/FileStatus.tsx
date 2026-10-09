import type { RunFileStatus } from "../../types/review-run.ts";
import styles from "./FileStatus.module.css";

const LETTER: Record<RunFileStatus, string> = {
  added: "A",
  removed: "D",
  modified: "M",
  renamed: "R",
  copied: "C",
};

export function FileStatus({ status }: { status: RunFileStatus }) {
  return (
    <span className={styles.status} data-status={status} title={status}>
      {LETTER[status]}
    </span>
  );
}
