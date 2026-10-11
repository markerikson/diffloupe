import type { ReviewStage } from "../../server/types.ts";
import { formatCost } from "../lib/format.ts";
import type { RunProgress } from "../store/api.ts";
import styles from "./ProgressStrip.module.css";

const STAGE_LABEL: Record<ReviewStage, string> = {
  resolving_target: "Resolving target",
  checking_registry: "Checking registry",
  building_map: "Building repo map",
  grouping: "Grouping files",
  reviewing: "Reviewing",
  coordinating: "Merging findings",
  walkthrough: "Writing walkthrough",
  verifying: "Verifying",
  writing: "Writing results",
};

export function ProgressStrip({ progress }: { progress: RunProgress | undefined }) {
  const p = progress;
  const finished = p ? p.slicesDone + p.slicesFailed : 0;
  const pct = p && p.slicesTotal > 0 ? Math.round((finished / p.slicesTotal) * 100) : null;
  return (
    <div className={styles.strip} role="status" aria-live="polite">
      <span className={styles.stage}>{p?.stage ? STAGE_LABEL[p.stage] : "Starting"}…</span>
      {p && p.slicesTotal > 0 && (
        <span className={styles.slices}>
          <span className={styles.bar}>
            <span className={styles.fill} style={{ width: `${pct}%` }} />
          </span>
          {finished}/{p.slicesTotal} slices
          {p.slicesFailed > 0 && <span className={styles.failed}> ({p.slicesFailed} failed)</span>}
        </span>
      )}
      {p && p.activeSlices.length > 0 && (
        <span className={styles.active} title={p.activeSlices.join("\n")}>
          {p.activeSlices.join(", ")}
        </span>
      )}
      {p?.lastMessage && (
        <span className={styles.message} title={p.lastMessage}>
          {p.lastMessage}
        </span>
      )}
      {p && p.costUsd > 0 && <span className={styles.cost}>{formatCost(p.costUsd)}</span>}
    </div>
  );
}
