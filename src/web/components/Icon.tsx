import PhBookOpenDuotone from "~icons/ph/book-open-duotone";
import PhBugDuotone from "~icons/ph/bug-duotone";
import PhCircleWavyWarningDuotone from "~icons/ph/circle-wavy-warning-duotone";
import PhDotsThreeCircleDuotone from "~icons/ph/dots-three-circle-duotone";
import PhFlaskDuotone from "~icons/ph/flask-duotone";
import PhGearDuotone from "~icons/ph/gear-duotone";
import PhPathDuotone from "~icons/ph/path-duotone";
import PhWrenchDuotone from "~icons/ph/wrench-duotone";
import type { GroupIcon as GroupIconName } from "../../types/review-run.ts";
import styles from "./Icon.module.css";

const GROUP_ICONS = {
  bug: PhBugDuotone,
  wrench: PhWrenchDuotone,
  path: PhPathDuotone,
  flask: PhFlaskDuotone,
  doc: PhBookOpenDuotone,
  gear: PhGearDuotone,
} satisfies Record<GroupIconName, unknown>;

interface GroupIconProps {
  icon: GroupIconName | undefined;
  className?: string | undefined;
}

export function GroupIcon({ icon, className }: GroupIconProps) {
  const Component = icon ? GROUP_ICONS[icon] : PhDotsThreeCircleDuotone;
  return (
    <Component
      className={[styles.icon, className].filter(Boolean).join(" ")}
      data-icon={icon ?? "missing"}
      aria-hidden
    />
  );
}

export function CriticalMark({ reason }: { reason?: string | undefined }) {
  const label = reason ? `Critical: ${reason}` : "Critical";
  return (
    <span className={styles.critical} title={label}>
      <PhCircleWavyWarningDuotone aria-label={label} />
    </span>
  );
}
