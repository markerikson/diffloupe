import PhCaretDown from "~icons/ph/caret-down";
import PhCaretRight from "~icons/ph/caret-right";
import type { RunFile, RunGroup } from "../../types/review-run.ts";
import type { GroupStats } from "../lib/group-tree.ts";
import { plural } from "../lib/format.ts";
import { scrollToGroup } from "../lib/navigate.ts";
import { DiffStats } from "./DiffStats.tsx";
import { FileTree } from "./FileTree.tsx";
import { CriticalMark, GroupIcon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import styles from "./GroupPanel.module.css";

interface GroupPanelProps {
  group: RunGroup;
  parent: RunGroup | undefined;
  stats: GroupStats;
  files: readonly RunFile[];
  allCollapsed: boolean;
  activePath: string | undefined;
  onToggleFiles: () => void;
  onSelectFile: (path: string) => void;
}

export function GroupPanel({
  group,
  parent,
  stats,
  files,
  allCollapsed,
  activePath,
  onToggleFiles,
  onSelectFile,
}: GroupPanelProps) {
  return (
    <aside className={styles.panel}>
      <div className={styles.head}>
        {parent && (
          <button type="button" className={styles.crumb} onClick={() => scrollToGroup(parent.id)}>
            {parent.title} ›
          </button>
        )}
        <div className={styles.titleRow}>
          <button
            type="button"
            className={styles.caret}
            onClick={onToggleFiles}
            title={allCollapsed ? "Expand all files in this group" : "Collapse all files in this group"}
          >
            {allCollapsed ? <PhCaretRight aria-hidden /> : <PhCaretDown aria-hidden />}
          </button>
          <GroupIcon icon={group.icon} className={styles.icon} />
          <h2 className={styles.title}>{group.title}</h2>
          {stats.critical && <CriticalMark reason={stats.criticalReason} />}
        </div>
        <div className={styles.stats}>
          <DiffStats additions={stats.additions} deletions={stats.deletions} binary={stats.binary === stats.files} />
          <span>{plural(stats.files, "file")}</span>
        </div>
      </div>
      {group.summary && <Markdown source={group.summary} className={styles.summary} />}
      <FileTree files={files} activePath={activePath} onSelect={onSelectFile} />
    </aside>
  );
}
