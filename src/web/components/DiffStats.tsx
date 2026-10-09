import styles from "./DiffStats.module.css";

interface DiffStatsProps {
  additions: number;
  deletions: number;
}

export function DiffStats({ additions, deletions }: DiffStatsProps) {
  return (
    <span className={styles.stats}>
      <span className={styles.add}>+{additions}</span>
      <span className={styles.del}>-{deletions}</span>
    </span>
  );
}
