import { Virtualizer } from "@pierre/diffs";
import { VirtualizerContext } from "@pierre/diffs/react";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RunFile } from "../../types/review-run.ts";
import { ChapterBand, UnitSection } from "../components/GroupSection.tsx";
import { Header } from "../components/Header.tsx";
import { Sidebar } from "../components/Sidebar.tsx";
import { buildGroupTree } from "../lib/group-tree.ts";
import { WIDE_QUERY, useMediaQuery } from "../lib/media.ts";
import { scrollToFile } from "../lib/navigate.ts";
import { parseRunPatch } from "../lib/patch.ts";
import { useScrollSpy } from "../lib/scroll-spy.ts";
import { useGetRunPatchQuery, useGetRunQuery } from "../store/api.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import {
  fileExpanded,
  filesCollapsedSet,
  groupFoldToggled,
  selectCollapsedFiles,
  selectCollapsedGroups,
  selectSidebar,
} from "../store/view.ts";
import styles from "./RunPage.module.css";

const route = getRouteApi("/runs/$runId");
const EMPTY: readonly string[] = [];

/** One window-scrolled virtualizer shared by every FileDiff on the page. */
function useWindowVirtualizer() {
  const [virtualizer, setVirtualizer] = useState<Virtualizer | null>(null);
  useEffect(() => {
    const v = new Virtualizer();
    v.setup(document);
    setVirtualizer(v);
    return () => {
      v.cleanUp();
      setVirtualizer(null);
    };
  }, []);
  return virtualizer;
}

export function RunPage() {
  const { runId } = route.useParams();
  const { file: searchFile } = route.useSearch();
  const loaderData = route.useLoaderData();
  const dispatch = useAppDispatch();
  const { data: run } = useGetRunQuery(runId);
  const { data: patch } = useGetRunPatchQuery(runId);
  const diffs = patch === undefined ? loaderData.files : parseRunPatch(runId, patch);
  const virtualizer = useWindowVirtualizer();
  const wide = useMediaQuery(WIDE_QUERY);
  const sidebar = useAppSelector(selectSidebar);
  const collapsedList = useAppSelector((s) => selectCollapsedFiles(s, runId)) ?? EMPTY;
  const foldedList = useAppSelector((s) => selectCollapsedGroups(s, runId)) ?? EMPTY;
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);
  const folded = useMemo(() => new Set(foldedList), [foldedList]);

  const tree = useMemo(() => (run ? buildGroupTree(run.groups, run.files, run) : null), [run]);
  const filesByGroup = useMemo(() => {
    const map = new Map<string, RunFile[]>();
    for (const f of run?.files ?? []) {
      const list = map.get(f.groupId);
      if (list) list.push(f);
      else map.set(f.groupId, [f]);
    }
    return map;
  }, [run]);

  const spy = useScrollSpy(virtualizer !== null, tree);
  const visible = useMemo(() => new Set(spy.groups), [spy.groups]);

  useEffect(() => {
    if (!searchFile || !run || !virtualizer) return;
    const file = run.files.find((f) => f.path === searchFile);
    if (!file) return;
    dispatch(fileExpanded({ runId, path: file.path }));
    scrollToFile(file.groupId, file.path);
  }, [searchFile, run, virtualizer, dispatch, runId]);

  const collapseActions = useMemo(() => {
    const all = run?.files.map((f) => f.path) ?? [];
    const set = (paths: string[]) => () => dispatch(filesCollapsedSet({ runId, paths }));
    return [
      { label: "Expand all files", run: set([]) },
      { label: "Collapse all files", run: set(all) },
      {
        label: "Collapse skipped files",
        run: set(run?.files.filter((f) => f.classification === "skip").map((f) => f.path) ?? []),
      },
    ];
  }, [dispatch, run, runId]);

  const onToggleFold = useCallback((groupId: string) => dispatch(groupFoldToggled({ runId, groupId })), [dispatch, runId]);

  if (!run || !tree) return <RunPageSkeleton />;

  const showSidebar = wide && sidebar;

  return (
    <div className={styles.page}>
      <Header run={run} tree={tree} visible={visible} collapseActions={collapseActions} />
      <div className={styles.body}>
        {showSidebar && (
          <aside className={styles.aside}>
            <div className={styles.asideInner}>
              <Sidebar tree={tree} visible={visible} folded={folded} onToggleFold={onToggleFold} />
            </div>
          </aside>
        )}
        <main className={styles.main}>
          {virtualizer && (
            <VirtualizerContext.Provider value={virtualizer}>
              {tree.chapters.map(({ chapter, units }, i) => {
                const isFolded = chapter !== null && folded.has(chapter.id);
                const chapterFiles = chapter ? (filesByGroup.get(chapter.id) ?? []) : [];
                return (
                  <div key={chapter?.id ?? `loose-${i}`} className={styles.chapter}>
                    {chapter &&
                      (chapterFiles.length > 0 ? (
                        <UnitSection
                          runId={runId}
                          group={chapter}
                          parent={undefined}
                          stats={tree.stats.get(chapter.id)!}
                          files={chapterFiles}
                          diffs={diffs}
                          collapsed={collapsed}
                          activePath={spy.files[chapter.id]}
                        />
                      ) : (
                        <ChapterBand
                          chapter={chapter}
                          stats={tree.stats.get(chapter.id)!}
                          unitCount={units.length}
                          folded={isFolded}
                          onToggleFold={() => onToggleFold(chapter.id)}
                        />
                      ))}
                    {!isFolded &&
                      units.map((unit) => (
                        <UnitSection
                          key={unit.id}
                          runId={runId}
                          group={unit}
                          parent={chapter ?? undefined}
                          stats={tree.stats.get(unit.id)!}
                          files={filesByGroup.get(unit.id) ?? EMPTY_FILES}
                          diffs={diffs}
                          collapsed={collapsed}
                          activePath={spy.files[unit.id]}
                        />
                      ))}
                  </div>
                );
              })}
            </VirtualizerContext.Provider>
          )}
          <p className={styles.end}>End of diff</p>
        </main>
      </div>
    </div>
  );
}

const EMPTY_FILES: readonly RunFile[] = [];

export function RunPageSkeleton() {
  return (
    <div className={styles.skeleton} aria-busy="true">
      <div className={styles.skeletonHeader} />
      <div className={styles.skeletonBody}>
        <div className={styles.skeletonAside} />
        <div className={styles.skeletonMain}>
          <div />
          <div />
          <div />
        </div>
      </div>
    </div>
  );
}
