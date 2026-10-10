import { Virtualizer } from "@pierre/diffs";
import { VirtualizerContext } from "@pierre/diffs/react";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunFile } from "../../types/review-run.ts";
import { CopyFallbackDialog } from "../components/CopyFallbackDialog.tsx";
import { ChapterBand, type FileSelection, UnitSection } from "../components/GroupSection.tsx";
import { Header } from "../components/Header.tsx";
import { KeyboardHelp } from "../components/KeyboardHelp.tsx";
import { Sidebar } from "../components/Sidebar.tsx";
import { SummaryBlock } from "../components/SummaryBlock.tsx";
import { useKeyboardNav } from "../hooks/useKeyboardNav.ts";
import { type RunAnnotation, anchorSelection, fileAnnotations } from "../lib/annotations.ts";
import { copyText } from "../lib/clipboard.ts";
import { buildGroupTree } from "../lib/group-tree.ts";
import { WIDE_QUERY, useMediaQuery } from "../lib/media.ts";
import { scrollToCard, scrollToFile } from "../lib/navigate.ts";
import { navLists } from "../lib/navigation.ts";
import { parseRunPatch } from "../lib/patch.ts";
import { type RunNav, RunNavContext } from "../lib/run-nav.ts";
import { useScrollSpy } from "../lib/scroll-spy.ts";
import { useGetRunPatchQuery, useGetRunQuery } from "../store/api.ts";
import {
  fileFocused,
  findingFocused,
  overCapToggled,
  runEntered,
  selectFocusedFinding,
  selectFocusedStop,
  selectShowOverCap,
  selectStopLocation,
  stopFocused,
} from "../store/focus.ts";
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

type RunSearch = ReturnType<typeof route.useSearch>;

function withFocus(prev: RunSearch, focus: { finding: string } | { stop: string }): RunSearch {
  const { finding: _f, stop: _s, ...rest } = prev;
  return { ...rest, ...focus };
}

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
  const { file: searchFile, finding: searchFinding, stop: searchStop } = route.useSearch();
  const navigate = route.useNavigate();
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
  const showOverCap = useAppSelector(selectShowOverCap);
  const focusedFinding = useAppSelector(selectFocusedFinding);
  const focusedStop = useAppSelector(selectFocusedStop);
  const stopLocation = useAppSelector(selectStopLocation);
  const [fallbackText, setFallbackText] = useState<string | null>(null);

  useEffect(() => {
    dispatch(runEntered(runId));
  }, [dispatch, runId]);

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
  const index = useMemo(() => {
    const findings = [...(run?.findings ?? []), ...(run?.overCapFindings ?? [])];
    return {
      files: new Map((run?.files ?? []).map((f) => [f.path, f])),
      findings: new Map(findings.map((f) => [f.id, f])),
      overCap: new Set((run?.overCapFindings ?? []).map((f) => f.id)),
      stops: new Map((run?.stops ?? []).map((s) => [s.id, s])),
    };
  }, [run]);
  const annotations = useMemo(
    () => (run ? fileAnnotations(run, { showOverCap }) : new Map<string, RunAnnotation[]>()),
    [run, showOverCap],
  );
  const lists = useMemo(() => (run && tree ? navLists(run, tree, { showOverCap }) : null), [run, tree, showOverCap]);

  const spy = useScrollSpy(virtualizer !== null, tree);
  const visible = useMemo(() => new Set(spy.groups), [spy.groups]);

  const live = useRef({ folded, showOverCap });
  live.current = { folded, showOverCap };

  /** Expands the file (and its folded chapter), then scrolls to the card or the file. */
  const reveal = useCallback(
    (path: string, elementId: string | null) => {
      const file = index.files.get(path);
      if (!file) return;
      dispatch(fileExpanded({ runId, path }));
      const parentId = tree?.byId.get(file.groupId)?.parentId;
      if (parentId && live.current.folded.has(parentId)) dispatch(groupFoldToggled({ runId, groupId: parentId }));
      if (elementId) scrollToCard(file.groupId, path, elementId);
      else scrollToFile(file.groupId, path, { focus: true });
    },
    [dispatch, index, runId, tree],
  );

  const nav = useMemo(
    (): RunNav => ({
      runId,
      stops: run?.stops ?? [],
      goToFile(path) {
        dispatch(fileFocused(path));
        reveal(path, null);
      },
      goToFinding(id, opts) {
        const f = index.findings.get(id);
        if (!f) return;
        if (index.overCap.has(id) && !live.current.showOverCap) dispatch(overCapToggled());
        dispatch(findingFocused({ id, file: f.anchor.file }));
        void navigate({ search: (prev) => withFocus(prev, { finding: id }), replace: true });
        if (opts?.scroll !== false) reveal(f.anchor.file, `finding-${id}`);
      },
      goToStop(id, location = 0, opts) {
        const stop = index.stops.get(id);
        if (!stop) return;
        const loc = stop.locations[location];
        dispatch(stopFocused({ id, location, ...(loc ? { file: loc.file } : {}) }));
        void navigate({ search: (prev) => withFocus(prev, { stop: id }), replace: true });
        if (loc && opts?.scroll !== false) reveal(loc.file, `stop-${id}-${location}`);
      },
      async copy(text) {
        const ok = await copyText(text);
        if (!ok) setFallbackText(text);
        return ok;
      },
    }),
    [dispatch, index, navigate, reveal, run?.stops, runId],
  );

  useEffect(() => {
    if (!searchFile || !run || !virtualizer) return;
    const file = run.files.find((f) => f.path === searchFile);
    if (!file) return;
    dispatch(fileExpanded({ runId, path: file.path }));
    scrollToFile(file.groupId, file.path);
  }, [searchFile, run, virtualizer, dispatch, runId]);

  const ready = run !== undefined && virtualizer !== null;
  useEffect(() => {
    if (ready && searchFinding && searchFinding !== focusedFinding) nav.goToFinding(searchFinding);
    // Only follow URL changes; focus changes made on the page already update the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, searchFinding]);
  useEffect(() => {
    if (ready && searchStop && searchStop !== focusedStop) nav.goToStop(searchStop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, searchStop]);

  useKeyboardNav(lists, nav, runId);

  const selection = useMemo((): FileSelection | null => {
    if (focusedFinding) {
      const f = index.findings.get(focusedFinding);
      return f ? { path: f.anchor.file, range: anchorSelection(f.anchor) } : null;
    }
    const loc = focusedStop ? index.stops.get(focusedStop)?.locations[stopLocation] : undefined;
    return loc ? { path: loc.file, range: anchorSelection(loc) } : null;
  }, [focusedFinding, focusedStop, index, stopLocation]);
  const selectionGroup = selection ? index.files.get(selection.path)?.groupId : undefined;
  const selectionFor = (groupId: string) => (selectionGroup === groupId ? selection : null);

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
    <RunNavContext.Provider value={nav}>
      <div className={styles.page}>
        <Header run={run} tree={tree} visible={visible} collapseActions={collapseActions} />
        <div className={styles.body}>
          {showSidebar && (
            <aside className={styles.aside}>
              <div className={styles.asideInner}>
                <Sidebar run={run} tree={tree} visible={visible} folded={folded} onToggleFold={onToggleFold} />
              </div>
            </aside>
          )}
          <main className={styles.main}>
            <SummaryBlock run={run} />
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
                            annotations={annotations}
                            selection={selectionFor(chapter.id)}
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
                            annotations={annotations}
                            selection={selectionFor(unit.id)}
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
        <KeyboardHelp />
        {fallbackText !== null && <CopyFallbackDialog text={fallbackText} onClose={() => setFallbackText(null)} />}
      </div>
    </RunNavContext.Provider>
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
