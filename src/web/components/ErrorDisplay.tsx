/**
 * ErrorDisplay - Shows error messages from analysis
 */

import styles from "./ErrorDisplay.module.css";

export interface ErrorDisplayProps {
  error: string;
  onDismiss?: () => void;
}

export function ErrorDisplay({ error, onDismiss }: ErrorDisplayProps) {
  return (
    <div className={styles.container} role="alert">
      <div className={styles.content}>
        <span className={styles.icon} aria-hidden="true">!</span>
        <p className={styles.message}>{error}</p>
      </div>
      {onDismiss && (
        <button
          type="button"
          className={styles.dismissButton}
          onClick={onDismiss}
          aria-label="Dismiss error"
        >
          ×
        </button>
      )}
    </div>
  );
}
