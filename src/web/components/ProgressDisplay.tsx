/**
 * ProgressDisplay - Shows analysis progress with progress bar and status messages
 */

import type { AnalysisProgress } from "../store/api";
import styles from "./ProgressDisplay.module.css";

export interface ProgressDisplayProps {
  progress?: AnalysisProgress;
}

export function ProgressDisplay({ progress }: ProgressDisplayProps) {
  const percent = progress?.percent ?? 0;
  const message = progress?.message ?? "Starting analysis...";
  const detail = progress?.detail;

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <span className={styles.spinner} aria-hidden="true" />

        <div className={styles.progressBarContainer}>
          <div
            className={styles.progressBar}
            style={{ width: `${percent}%` }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>

        <span className={styles.percent}>{percent}%</span>
        <span className={styles.message}>{message}</span>
        {detail && <span className={styles.detail}>{detail}</span>}
      </div>
    </div>
  );
}
