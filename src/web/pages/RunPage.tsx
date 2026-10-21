import { Virtualizer } from "@pierre/diffs";
import { VirtualizerContext } from "@pierre/diffs/react";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunFile, RunFinding } from "../../types/review-run.ts";
import { CopyFallbackDialog } from "../components/CopyFallbackDialog.tsx";
import { ChapterBand, type FileSelection, UnitSection } from "../components/GroupSection.tsx";
import { Header } from "../components/Header.tsx";
import { KeyboardHelp } from "../components/KeyboardHelp.tsx";
import { Sidebar } from "../components/Sidebar.tsx";
import { SUMMARY_ID, SummaryBlock } from "../components/SummaryBlock.tsx";
import { useKeyboardNav } from "../hooks/useKeyboardNav.ts";
import { type RunAnnotation, anchorSelection, fileAnnotations } from "../lib/annotations.ts";
import { copyText } from "../lib/clipboard.ts";
import { buildGroupTree } from "../lib/group-tree.ts";
import { revisitingEntry, useHistoryScroll } from "../lib/history-scroll.ts";
import { WIDE_QUERY, useMediaQuery } from "../lib/media.ts";
import { scrollToCard, scrollToFile } from "../lib/navigate.ts";
import { navLists } from "../lib/navigation.ts";
import { parseRunPatch } from "../lib/patch.ts";
import { type GoToOptions, type RunNav, RunNavContext } from "../lib/run-nav.ts";
import { useScrollSpy } from "../lib/scroll-spy.ts";
import { useGetRunPatchQuery, useGetRunQuery } from "../store/api.ts";
import {
  dismissedToggled,
  fileFocused,
  findingFocused,
  overCapToggled,
  runEntered,
  selectFocusedFinding,
  selectFocusedStop,
  selectShowDismissed,
  selectShowOverCap,
  selectStopLocation,
  stopFocused,
} from "../store/focus.ts";
import { useChangeRunState, useDismissedIds } from "../hooks/useRunState.ts";
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

function withFocus(prev: RunSearch, focus: { finding: string } | { stop: string } | null): RunSearch {
  const { finding: _f, stop: _s, file: _p, ...rest } = prev;
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
  const showDismissed = useAppSelector(selectShowDismissed);
  const dismissed = useDismissedIds(runId);
  const hidden = showDismissed ? NO_IDS : dismissed;
  const changeState = useChangeRunState(runId);
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
    () => (run ? fileAnnotations(run, { showOverCap, hidden }) : new Map<string, RunAnnotation[]>()),
    [run, showOverCap, hidden],
  );
  const lists = useMemo(
    () => (run && tree ? navLists(run, tree, { showOverCap, hidden }) : null),
    [run, tree, showOverCap, hidden],
  );
  // Dismissed findings stay out of n/p even while they are shown.
  const keyLists = useMemo(
    () => lists && { ...lists, findings: lists.findings.filter((f) => !dismissed.has(f.id)) },
    [lists, dismissed],
  );

  const spy = useScrollSpy(virtualizer !== null, tree);
  const visible = useMemo(() => new Set(spy.groups), [spy.groups]);

  const live = useRef({ folded, showOverCap, showDismissed, dismissed, collapsedList });
  live.current = { folded, showOverCap, showDismissed, dismissed, collapsedList };

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

  const nav = useMemo((): RunNav => {
    /**
     * Jumps get their own history entry so Back returns to the previous spot;
     * focusing a card that is already on screen only rewrites the current one.
     */
    const record = (focus: { finding: string } | { stop: string }, opts: GoToOptions | undefined) => {
      if (opts?.fromUrl) return;
      void navigate({
        search: (prev) => withFocus(prev, focus),
        replace: opts?.scroll === false,
        resetScroll: false,
      });
    };
    return {
      runId,
      stops: run?.stops ?? [],
      goToTop() {
        dispatch(findingFocused({ id: null }));
        dispatch(stopFocused({ id: null }));
        // The router saves the current scroll position for Back, then resets to the top.
        void navigate({ search: (prev) => withFocus(prev, null) }).then(() =>
          document.getElementById(SUMMARY_ID)?.focus({ preventScroll: true }),
        );
      },
      goToFile(path) {
        dispatch(fileFocused(path));
        reveal(path, null);
      },
      goToFinding(id, opts) {
        const f = index.findings.get(id);
        if (!f) return;
        if (index.overCap.has(id) && !live.current.showOverCap) dispatch(overCapToggled());
        if (live.current.dismissed.has(id) && !live.current.showDismissed) dispatch(dismissedToggled());
        dispatch(findingFocused({ id, file: f.anchor.file }));
        record({ finding: id }, opts);
        if (opts?.scroll !== false) reveal(f.anchor.file, `finding-${id}`);
      },
      goToStop(id, location = 0, opts) {
        const stop = index.stops.get(id);
        if (!stop) return;
        const loc = stop.locations[location];
        dispatch(stopFocused({ id, location, ...(loc ? { file: loc.file } : {}) }));
        // Moving between locations of one stop keeps the same URL, so it rewrites the entry.
        record({ stop: id }, location > 0 ? { ...opts, scroll: false } : opts);
        if (loc && opts?.scroll !== false) reveal(loc.file, `stop-${id}-${location}`);
      },
      async copy(text) {
        const ok = await copyText(text);
        if (!ok) setFallbackText(text);
        return ok;
      },
      setReviewed(path, reviewed) {
        const file = index.files.get(path);
        // The server only accepts state changes once the run has finished.
        if (!file || run?.status === "running") return;
        changeState({ op: "reviewed", paths: [path], value: reviewed });
        if (!reviewed) {
          dispatch(fileExpanded({ runId, path }));
          return;
        }
        const others = live.current.collapsedList.filter((p) => p !== path);
        dispatch(filesCollapsedSet({ runId, paths: [...others, path] }));
        // Keeps the collapsed header at the top, so the next file follows right below it.
        scrollToFile(file.groupId, path, { focus: true });
      },
    };
  }, [changeState, dispatch, index, navigate, reveal, run?.status, run?.stops, runId]);

  useEffect(() => {
    if (!searchFile || !run || !virtualizer) return;
    const file = run.files.find((f) => f.path === searchFile);
    if (!file) return;
    dispatch(fileExpanded({ runId, path: file.path }));
    scrollToFile(file.groupId, file.path);
  }, [searchFile, run, virtualizer, dispatch, runId]);

  const ready = run !== undefined && virtualizer !== null;
  // Back/Forward restores the scroll position saved with that entry, so only refocus.
  useHistoryScroll();
  const fromUrl = (): GoToOptions => ({ fromUrl: true, scroll: !revisitingEntry() });

  // Only follow URL changes (Back/Forward, pasted links); focus changes made on the page already update the URL.
  useEffect(() => {
    if (!ready) return;
    if (searchFinding && searchFinding !== focusedFinding) nav.goToFinding(searchFinding, fromUrl());
    else if (!searchFinding && focusedFinding) dispatch(findingFocused({ id: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, searchFinding]);
  useEffect(() => {
    if (!ready) return;
    if (searchStop && searchStop !== focusedStop) nav.goToStop(searchStop, 0, fromUrl());
    else if (!searchStop && focusedStop) dispatch(stopFocused({ id: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, searchStop]);

  useKeyboardNav(keyLists, nav, runId);

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
                <Sidebar
                  run={run}
                  tree={tree}
                  visible={visible}
                  folded={folded}
                  onToggleFold={onToggleFold}
                  findings={lists?.findings ?? EMPTY_FINDINGS}
                  overCap={index.overCap}
                  dismissed={dismissed}
                />
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
const NO_IDS: ReadonlySet<string> = new Set();
const EMPTY_FINDINGS: readonly RunFinding[] = [];

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
