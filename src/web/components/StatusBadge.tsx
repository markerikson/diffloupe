import PhCheckCircleDuotone from "~icons/ph/check-circle-duotone";
import PhCircleNotch from "~icons/ph/circle-notch";
import PhProhibitDuotone from "~icons/ph/prohibit-duotone";
import PhWarningCircleDuotone from "~icons/ph/warning-circle-duotone";
import type { RunStatus } from "../../types/review-run.ts";
import styles from "./StatusBadge.module.css";

const ICONS = {
  running: PhCircleNotch,
  complete: PhCheckCircleDuotone,
  failed: PhWarningCircleDuotone,
  cancelled: PhProhibitDuotone,
} satisfies Record<RunStatus, unknown>;

interface StatusBadgeProps {
  status: RunStatus;
  /** Show only the icon, with the status as its tooltip. */
  compact?: boolean;
}

export function StatusBadge({ status, compact = false }: StatusBadgeProps) {
  const Icon = ICONS[status];
  return (
    <span className={styles.badge} data-status={status} title={status}>
      <Icon className={styles.icon} aria-hidden />
      {!compact && <span>{status}</span>}
    </span>
  );
}
