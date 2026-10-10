import PhCaretDown from "~icons/ph/caret-down";
import PhCaretRight from "~icons/ph/caret-right";
import type { ReviewRun, RunFinding, RunGroup } from "../../types/review-run.ts";
import { plural } from "../lib/format.ts";
import type { GroupStats, GroupTree } from "../lib/group-tree.ts";
import { keepInView, scrollToGroup } from "../lib/navigate.ts";
import { useEffect, useRef } from "react";
import { type SidebarMode, selectSidebarMode, sidebarModeSet } from "../store/focus.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { DiffStats } from "./DiffStats.tsx";
import { FindingNavList } from "./FindingNavList.tsx";
import { GuideList } from "./GuideList.tsx";
import { CriticalMark, GroupIcon } from "./Icon.tsx";
import styles from "./Sidebar.module.css";

interface SidebarRowProps {
  group: RunGroup;
  stats: GroupStats | undefined;
  depth: number;
  visible: boolean;
  fold?: { folded: boolean; onToggle: () => void } | undefined;
}

function SidebarRow({ group, stats, depth, visible, fold }: SidebarRowProps) {
  return (
    <li className={styles.row} data-visible={visible} data-depth={depth}>
      {fold ? (
        <button
          type="button"
          className={styles.caret}
          onClick={fold.onToggle}
          title={fold.folded ? "Show units" : "Hide units"}
          aria-expanded={!fold.folded}
        >
          {fold.folded ? <PhCaretRight aria-hidden /> : <PhCaretDown aria-hidden />}
        </button>
      ) : (
        <span className={styles.caretSpace} />
      )}
      <button type="button" className={styles.link} onClick={() => scrollToGroup(group.id)}>
        <span className={styles.label}>
          <GroupIcon icon={group.icon} className={styles.icon} />
          <span className={styles.title}>{group.title}</span>
          {stats?.critical && <CriticalMark reason={stats.criticalReason} />}
        </span>
        {stats && stats.files > 0 && (
          <span className={styles.sub}>
            <DiffStats additions={stats.additions} deletions={stats.deletions} />
            <span>・{plural(stats.files, "file")}</span>
          </span>
        )}
        {stats?.files === 0 && group.stopIds.length > 0 && <span className={styles.sub}>Walkthrough only</span>}
      </button>
    </li>
  );
}

interface SidebarProps {
  run: Pick<ReviewRun, "groups" | "stops" | "findings" | "overCapFindings">;
  tree: GroupTree;
  visible: ReadonlySet<string>;
  folded: ReadonlySet<string>;
  onToggleFold: (groupId: string) => void;
  /** Findings on the page, in page order. */
  findings: readonly RunFinding[];
  overCap: ReadonlySet<string>;
}

const MODE_LABEL: Record<SidebarMode, string> = { groups: "Groups", findings: "Findings", guide: "Guide" };

export function Sidebar({ run, tree, visible, folded, onToggleFold, findings, overCap }: SidebarProps) {
  const dispatch = useAppDispatch();
  const savedMode = useAppSelector(selectSidebarMode);
  const modes: SidebarMode[] = ["groups"];
  if (run.findings.length + run.overCapFindings.length > 0) modes.push("findings");
  if (run.stops.length > 0) modes.push("guide");
  const mode = modes.includes(savedMode) ? savedMode : "groups";

  return (
    <div className={styles.sidebar}>
      {modes.length > 1 && (
        <div className={styles.modes} role="group" aria-label="Sidebar view">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              className={styles.mode}
              aria-pressed={mode === m}
              onClick={() => dispatch(sidebarModeSet(m))}
            >
              {MODE_LABEL[m]}
              {m === "findings" && <span className={styles.modeCount}>{findings.length}</span>}
            </button>
          ))}
        </div>
      )}
      {mode === "guide" && (
        <nav className={styles.nav} aria-label="Walkthrough">
          <GuideList groups={run.groups} stops={run.stops} />
        </nav>
      )}
      {mode === "findings" && (
        <nav className={styles.nav} aria-label="Findings">
          <FindingNavList findings={findings} overCap={overCap} />
        </nav>
      )}
      {mode === "groups" && <GroupList tree={tree} visible={visible} folded={folded} onToggleFold={onToggleFold} />}
    </div>
  );
}

function GroupList({ tree, visible, folded, onToggleFold }: Pick<SidebarProps, "tree" | "visible" | "folded" | "onToggleFold">) {
  const navRef = useRef<HTMLElement>(null);
  const firstVisible = tree.ordered.find((g) => visible.has(g.id))?.id;
  useEffect(() => {
    const nav = navRef.current;
    const container = nav?.parentElement?.parentElement;
    const row = nav?.querySelector<HTMLElement>('[data-visible="true"]');
    if (container && row) keepInView(container, row);
  }, [firstVisible]);

  return (
    <nav ref={navRef} className={styles.nav} aria-label="Groups">
      <ul className={styles.list}>
        {tree.chapters.flatMap(({ chapter, units }) => {
          const rows = [];
          if (chapter) {
            const isFolded = folded.has(chapter.id);
            rows.push(
              <SidebarRow
                key={chapter.id}
                group={chapter}
                stats={tree.stats.get(chapter.id)}
                depth={0}
                visible={visible.has(chapter.id)}
                fold={units.length > 0 ? { folded: isFolded, onToggle: () => onToggleFold(chapter.id) } : undefined}
              />,
            );
            if (isFolded) return rows;
          }
          for (const unit of units) {
            rows.push(
              <SidebarRow
                key={unit.id}
                group={unit}
                stats={tree.stats.get(unit.id)}
                depth={chapter ? 1 : 0}
                visible={visible.has(unit.id)}
              />,
            );
          }
          return rows;
        })}
      </ul>
    </nav>
  );
}
