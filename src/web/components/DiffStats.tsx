import styles from "./DiffStats.module.css";

interface DiffStatsProps {
  additions: number;
  deletions: number;
  /** Every counted file is binary, so the line counts say nothing. */
  binary?: boolean | undefined;
}

export function DiffStats({ additions, deletions, binary }: DiffStatsProps) {
  if (binary && additions === 0 && deletions === 0) return <span className={styles.binary}>binary</span>;
  return (
    <span className={styles.stats}>
      <span className={styles.add}>+{additions}</span>
      <span className={styles.del}>-{deletions}</span>
    </span>
  );
}
