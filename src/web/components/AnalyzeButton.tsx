/**
 * AnalyzeButton - Triggers analysis with loading/error states
 */

import styles from "./AnalyzeButton.module.css";

export interface AnalyzeButtonProps {
  onClick: () => void;
  disabled?: boolean;
  isLoading?: boolean;
}

export function AnalyzeButton({
  onClick,
  disabled = false,
  isLoading = false,
}: AnalyzeButtonProps) {
  return (
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
  );
}
