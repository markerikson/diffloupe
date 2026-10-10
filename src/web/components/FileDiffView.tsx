import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { FileDiff, type FileDiffOptions } from "@pierre/diffs/react";
import { memo, useCallback, useMemo } from "react";
import PhCaretDown from "~icons/ph/caret-down";
import PhCaretRight from "~icons/ph/caret-right";
import type { RunFile } from "../../types/review-run.ts";
import type { AnnotationMeta, RunAnnotation } from "../lib/annotations.ts";
import { NARROW_QUERY, useMediaQuery } from "../lib/media.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { fileCollapseToggled, selectDiffStyle, selectTheme, selectWrap } from "../store/view.ts";
import { DiffStats } from "./DiffStats.tsx";
import { FileStatus } from "./FileStatus.tsx";
import { FindingCard } from "./FindingCard.tsx";
import { GuideCard } from "./GuideCard.tsx";
import styles from "./FileDiffView.module.css";

const HEADER_CSS = `[data-diffs-header][data-sticky] { top: calc(var(--header-height, 0px) - 1px); }
[data-diffs-header] [data-additions-count], [data-diffs-header] [data-deletions-count] { display: none; }`;

const NO_ANNOTATIONS: RunAnnotation[] = [];

function AnnotationCard({ meta }: { meta: AnnotationMeta }) {
  return meta.kind === "finding" ? (
    <FindingCard finding={meta.finding} overCap={meta.overCap} />
  ) : (
    <GuideCard stop={meta.stop} location={meta.location} />
  );
}

function NoteCount({ annotations }: { annotations: readonly RunAnnotation[] }) {
  const findings = annotations.filter((a) => a.metadata.kind === "finding").length;
  const stops = annotations.length - findings;
  if (!findings && !stops) return null;
  const parts = [findings ? `${findings} finding${findings === 1 ? "" : "s"}` : "", stops ? `${stops} stop${stops === 1 ? "" : "s"}` : ""];
  return <span className={styles.count}>{parts.filter(Boolean).join(", ")}</span>;
}

interface FileDiffViewProps {
  runId: string;
  file: RunFile;
  diff: FileDiffMetadata | undefined;
  collapsed: boolean;
  annotations: RunAnnotation[] | undefined;
  selection: SelectedLineRange | null;
}

export const FileDiffView = memo(function FileDiffView({
  runId,
  file,
  diff,
  collapsed,
  annotations = NO_ANNOTATIONS,
  selection,
}: FileDiffViewProps) {
  const dispatch = useAppDispatch();
  const userStyle = useAppSelector(selectDiffStyle);
  const wrap = useAppSelector(selectWrap);
  const theme = useAppSelector(selectTheme);
  const narrow = useMediaQuery(NARROW_QUERY);
  const oneSided = file.status === "added" || file.status === "removed";
  const diffStyle = userStyle === "unified" || oneSided || narrow ? "unified" : "split";

  const options = useMemo(
    (): FileDiffOptions<AnnotationMeta, undefined> => ({
      diffStyle,
      overflow: wrap ? "wrap" : "scroll",
      themeType: theme,
      collapsed,
      stickyHeader: true,
      unsafeCSS: HEADER_CSS,
    }),
    [diffStyle, wrap, theme, collapsed],
  );
  const renderAnnotation = useCallback((a: RunAnnotation) => <AnnotationCard meta={a.metadata} />, []);

  const toggle = () => dispatch(fileCollapseToggled({ runId, path: file.path }));
  const caret = (
    <button
      type="button"
      className={styles.caret}
      onClick={toggle}
      aria-expanded={!collapsed}
      title={collapsed ? "Expand file" : "Collapse file"}
    >
      {collapsed ? <PhCaretRight aria-hidden /> : <PhCaretDown aria-hidden />}
    </button>
  );

  const hasHunks = diff !== undefined && diff.hunks.length > 0;
  if (file.isBinary || !hasHunks) {
    return (
      <div className={styles.frame} data-collapsed={collapsed}>
        <div className={styles.plainHeader}>
          {caret}
          <span className={styles.path} title={file.path}>
            {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
          </span>
          <span className={styles.meta}>
            <NoteCount annotations={annotations} />
            {file.isBinary ? <span className={styles.tag}>binary</span> : <DiffStats additions={file.additions} deletions={file.deletions} />}
            <FileStatus status={file.status} />
          </span>
        </div>
        {!collapsed && (
          <>
            <div className={styles.placeholder}>
              {file.isBinary ? "Binary file not shown." : diff ? "No content changes." : "This file is not in the saved patch."}
            </div>
            {annotations.length > 0 && (
              <div className={styles.cards}>
                {annotations.map((a, i) => (
                  <AnnotationCard key={i} meta={a.metadata} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className={styles.frame} data-collapsed={collapsed}>
      <FileDiff
        fileDiff={diff}
        options={options}
        lineAnnotations={annotations}
        selectedLines={selection}
        renderAnnotation={renderAnnotation}
        renderHeaderPrefix={() => caret}
        renderHeaderMetadata={() => (
          <span className={styles.meta}>
            {collapsed && <NoteCount annotations={annotations} />}
            <DiffStats additions={file.additions} deletions={file.deletions} />
            <FileStatus status={file.status} />
          </span>
        )}
      />
    </div>
  );
});
