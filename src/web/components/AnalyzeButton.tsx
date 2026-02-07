/**
 * AnalyzeButton - Triggers analysis with loading/error states and optional cancel
 */

import styles from "./AnalyzeButton.module.css";

export interface AnalyzeButtonProps {
  onClick: () => void;
  onCancel?: () => void;
  disabled?: boolean;
  isLoading?: boolean;
}

export function AnalyzeButton({
  onClick,
  onCancel,
  disabled = false,
  isLoading = false,
}: AnalyzeButtonProps) {
  return (
    <div className={styles.container}>
      <button
        type="button"
        className={styles.button}
        onClick={onClick}
        disabled={disabled || isLoading}
        aria-busy={isLoading}
      >
        {isLoading ? (
          <>
            <span className={styles.spinner} aria-hidden="true" />
            <span>Analyzing...</span>
          </>
        ) : (
          <span>Analyze</span>
        )}
      </button>
      {isLoading && onCancel && (
        <button
          type="button"
          className={styles.cancelButton}
          onClick={onCancel}
          aria-label="Cancel analysis"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
