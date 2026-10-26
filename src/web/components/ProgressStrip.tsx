import type { ReviewStage } from "../../server/types.ts";
import { formatCost } from "../lib/format.ts";
import type { RunProgress } from "../store/api.ts";
import styles from "./ProgressStrip.module.css";

const STAGE_LABEL: Record<ReviewStage, string> = {
  resolving_target: "Preparing changes",
  checking_registry: "Checking review history",
  building_map: "Mapping code",
  grouping: "Grouping files",
  reviewing: "Reviewing groups",
  coordinating: "Summarizing review",
  walkthrough: "Preparing walkthrough",
  verifying: "Verifying findings",
  writing: "Saving results",
};

export function ProgressStrip({ progress }: { progress: RunProgress | undefined }) {
  const p = progress;
  const finished = p ? p.slicesDone + p.slicesFailed : 0;
  const pct = p && p.slicesTotal > 0 ? Math.round((finished / p.slicesTotal) * 100) : null;
  return (
    <div className={styles.strip}>
      <span className={styles.stage}>{p?.stage ? STAGE_LABEL[p.stage] : "Starting"}…</span>
      {p?.stage === "reviewing" && p.slicesTotal > 0 && (
        <span className={styles.slices}>
          <span className={styles.bar}>
            <span className={styles.fill} style={{ width: `${pct}%` }} />
          </span>
          {finished}/{p.slicesTotal} groups
          {p.slicesFailed > 0 && <span className={styles.failed}> ({p.slicesFailed} failed)</span>}
        </span>
      )}
      {p?.stage === "reviewing" && p.activeSlices.length > 0 && (
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
