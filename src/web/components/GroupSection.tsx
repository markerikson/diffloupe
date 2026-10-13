import type { SelectedLineRange } from "@pierre/diffs";
import { memo, useCallback } from "react";
import PhCaretDown from "~icons/ph/caret-down";
import PhCaretRight from "~icons/ph/caret-right";
import type { RunFile, RunGroup } from "../../types/review-run.ts";
import type { RunAnnotation } from "../lib/annotations.ts";
import { plural } from "../lib/format.ts";
import type { GroupStats } from "../lib/group-tree.ts";
import { groupElementId, scrollToFile } from "../lib/navigate.ts";
import type { PatchFiles } from "../lib/patch.ts";
import { useAppDispatch } from "../store/hooks.ts";
import { fileExpanded, filesCollapsedSet } from "../store/view.ts";
import { DiffStats } from "./DiffStats.tsx";
import { FileDiffView } from "./FileDiffView.tsx";
import { GroupPanel } from "./GroupPanel.tsx";
import { CriticalMark, GroupIcon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import styles from "./GroupSection.module.css";

interface ChapterBandProps {
  chapter: RunGroup;
  stats: GroupStats;
  unitCount: number;
  folded: boolean;
  onToggleFold: () => void;
}

export const ChapterBand = memo(function ChapterBand({ chapter, stats, unitCount, folded, onToggleFold }: ChapterBandProps) {
  return (
    <section id={groupElementId(chapter.id)} data-group-section={chapter.id} className={styles.chapter}>
      <button type="button" className={styles.chapterTitle} onClick={onToggleFold} aria-expanded={!folded}>
        {folded ? <PhCaretRight aria-hidden className={styles.caret} /> : <PhCaretDown aria-hidden className={styles.caret} />}
        <GroupIcon icon={chapter.icon} className={styles.chapterIcon} />
        <h2>{chapter.title}</h2>
        {stats.critical && <CriticalMark reason={stats.criticalReason} />}
      </button>
      {stats.files > 0 ? (
        <div className={styles.chapterStats}>
          <DiffStats additions={stats.additions} deletions={stats.deletions} binary={stats.binary === stats.files} />
          <span>{plural(stats.files, "file")}</span>
          {unitCount > 0 && <span>{plural(unitCount, "unit")}</span>}
        </div>
      ) : (
        chapter.stopIds.length > 0 && (
          <div className={styles.chapterStats}>
            <span>Walkthrough only: no files of its own. Its stops point at files in other groups.</span>
          </div>
        )
      )}
      {chapter.summary && <Markdown source={chapter.summary} className={styles.chapterSummary} />}
    </section>
  );
});

interface UnitSectionProps {
  runId: string;
  group: RunGroup;
  parent: RunGroup | undefined;
  stats: GroupStats;
  files: readonly RunFile[];
  diffs: PatchFiles;
  collapsed: ReadonlySet<string>;
  activePath: string | undefined;
  annotations: ReadonlyMap<string, RunAnnotation[]>;
  /** The focused finding or stop location, when it is in one of this unit's files. */
  selection: FileSelection | null;
}

export interface FileSelection {
  path: string;
  range: SelectedLineRange | null;
}

export const UnitSection = memo(function UnitSection({
  runId,
  group,
  parent,
  stats,
  files,
  diffs,
  collapsed,
  activePath,
  annotations,
  selection,
}: UnitSectionProps) {
  const dispatch = useAppDispatch();
  const allCollapsed = files.length > 0 && files.every((f) => collapsed.has(f.path));

  const onToggleFiles = useCallback(() => {
    const paths = new Set(collapsed);
    for (const f of files) {
      if (allCollapsed) paths.delete(f.path);
      else paths.add(f.path);
    }
    dispatch(filesCollapsedSet({ runId, paths: [...paths] }));
  }, [allCollapsed, collapsed, dispatch, files, runId]);

  const onSelectFile = useCallback(
    (path: string) => {
      dispatch(fileExpanded({ runId, path }));
      scrollToFile(group.id, path);
    },
    [dispatch, group.id, runId],
  );

  return (
    <section id={groupElementId(group.id)} data-group-section={group.id} className={styles.unit}>
      <GroupPanel
        group={group}
        parent={parent}
        stats={stats}
        files={files}
        allCollapsed={allCollapsed}
        activePath={activePath}
        onToggleFiles={onToggleFiles}
        onSelectFile={onSelectFile}
      />
      <div className={styles.files}>
        {files.map((file) => (
          <div key={file.path} className={styles.file}>
            <div
              data-file-start
              data-path={file.path}
              className={styles.marker}
              tabIndex={-1}
              aria-label={`File ${file.path}`}
            />
            <FileDiffView
              runId={runId}
              file={file}
              diff={diffs.get(file.path)}
              collapsed={collapsed.has(file.path)}
              annotations={annotations.get(file.path)}
              selection={selection?.path === file.path ? selection.range : null}
            />
          </div>
        ))}
        {files.length === 0 && <p className={styles.empty}>No files in this group.</p>}
      </div>
    </section>
  );
});
