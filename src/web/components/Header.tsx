import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import PhColumns from "~icons/ph/columns";
import PhDesktop from "~icons/ph/desktop";
import PhHouse from "~icons/ph/house";
import PhListBullets from "~icons/ph/list-bullets";
import PhMoon from "~icons/ph/moon";
import PhRows from "~icons/ph/rows";
import PhSidebarSimple from "~icons/ph/sidebar-simple";
import PhSun from "~icons/ph/sun";
import PhTextAlignLeft from "~icons/ph/text-align-left";
import PhTreeStructure from "~icons/ph/tree-structure";
import PhWrapText from "~icons/ph/arrow-u-down-left";
import PhArrowLineUp from "~icons/ph/arrow-line-up";
import PhKeyboard from "~icons/ph/keyboard";
import { useRunNav } from "../lib/run-nav.ts";
import { helpSet } from "../store/focus.ts";
import { formatCost, formatRelative, formatTarget, plural, shortSha } from "../lib/format.ts";
import type { GroupTree } from "../lib/group-tree.ts";
import { WIDE_QUERY, useMediaQuery } from "../lib/media.ts";
import { scrollToGroup } from "../lib/navigate.ts";
import { runKind } from "../../types/review-run.ts";
import { errorMessage } from "../routes/root.tsx";
import { useStartRunMutation, type RunWithProgress } from "../store/api.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import {
  diffStyleSet,
  fileTreeLayoutSet,
  selectDiffStyle,
  selectFileTreeLayout,
  selectSidebar,
  selectTheme,
  selectWrap,
  sidebarToggled,
  themeSet,
  wrapToggled,
  type ThemeSetting,
} from "../store/view.ts";
import { CollapseMenu, type CollapseAction } from "./CollapseMenu.tsx";
import { DiffStats } from "./DiffStats.tsx";
import { CriticalMark, GroupIcon } from "./Icon.tsx";
import { ProgressStrip } from "./ProgressStrip.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import styles from "./Header.module.css";

const NEXT_THEME: Record<ThemeSetting, ThemeSetting> = { system: "light", light: "dark", dark: "system" };
const THEME_ICON = { system: PhDesktop, light: PhSun, dark: PhMoon } satisfies Record<ThemeSetting, unknown>;

/**
 * Publishes the header's height as `--header-height` and hides it on narrow
 * screens after the user scrolls down 300px, showing it again on scroll up.
 */
function useStickyHeader(wide: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [hidden, setHidden] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--header-height", `${hidden ? 0 : height}px`);
  }, [height, hidden]);

  useEffect(
    () => () => {
      document.documentElement.style.removeProperty("--header-height");
    },
    [],
  );

  useEffect(() => {
    let lastY = window.scrollY;
    let downFrom = lastY;
    const onScroll = () => {
      const y = window.scrollY;
      if (y < lastY) downFrom = y;
      lastY = y;
      setScrolled(y > 20);
      setHidden(!wide && y - downFrom > 300);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [wide]);

  return { ref, hidden, scrolled };
}

function ToggleButton({
  title,
  pressed,
  onClick,
  children,
}: {
  title: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={styles.toggle} title={title} aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  );
}

function ViewControls({ collapseActions, wide }: { collapseActions: readonly CollapseAction[]; wide: boolean }) {
  const dispatch = useAppDispatch();
  const diffStyle = useAppSelector(selectDiffStyle);
  const wrap = useAppSelector(selectWrap);
  const theme = useAppSelector(selectTheme);
  const layout = useAppSelector(selectFileTreeLayout);
  const sidebar = useAppSelector(selectSidebar);
  const ThemeIcon = THEME_ICON[theme];
  const nav = useRunNav();
  return (
    <div className={styles.controls}>
      <ToggleButton title="Back to the summary (t)" onClick={() => nav.goToTop()}>
        <PhArrowLineUp aria-hidden />
      </ToggleButton>
      <CollapseMenu actions={collapseActions} />
      <ToggleButton
        title={diffStyle === "split" ? "Split view (switch to unified)" : "Unified view (switch to split)"}
        onClick={() => dispatch(diffStyleSet(diffStyle === "split" ? "unified" : "split"))}
      >
        {diffStyle === "split" ? <PhColumns aria-hidden /> : <PhRows aria-hidden />}
      </ToggleButton>
      <ToggleButton title={wrap ? "Wrap long lines: on" : "Wrap long lines: off"} pressed={wrap} onClick={() => dispatch(wrapToggled())}>
        {wrap ? <PhWrapText aria-hidden /> : <PhTextAlignLeft aria-hidden />}
      </ToggleButton>
      <ToggleButton
        title={layout === "tree" ? "File tree (switch to list)" : "File list (switch to tree)"}
        onClick={() => dispatch(fileTreeLayoutSet(layout === "tree" ? "list" : "tree"))}
      >
        {layout === "tree" ? <PhTreeStructure aria-hidden /> : <PhListBullets aria-hidden />}
      </ToggleButton>
      {wide && (
        <ToggleButton
          title={sidebar ? "Hide sidebar (show group tabs)" : "Show sidebar"}
          pressed={sidebar}
          onClick={() => dispatch(sidebarToggled())}
        >
          <PhSidebarSimple aria-hidden />
        </ToggleButton>
      )}
      <ToggleButton title={`Theme: ${theme}`} onClick={() => dispatch(themeSet(NEXT_THEME[theme]))}>
        <ThemeIcon aria-hidden />
      </ToggleButton>
      <ToggleButton title="Keyboard shortcuts (?)" onClick={() => dispatch(helpSet(true))}>
        <PhKeyboard aria-hidden />
      </ToggleButton>
    </div>
  );
}

function GroupTabs({ tree, visible }: { tree: GroupTree; visible: ReadonlySet<string> }) {
  const active = tree.ordered.find((g) => visible.has(g.id))?.id;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    ref.current
      ?.querySelector(`[data-group-id="${CSS.escape(active)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <div className={styles.tabs} ref={ref}>
      {tree.ordered.map((g) => {
        const stats = tree.stats.get(g.id);
        return (
          <button
            key={g.id}
            type="button"
            className={styles.tab}
            data-group-id={g.id}
            data-active={g.id === active}
            data-chapter={!g.parentId && g.files.length === 0}
            onClick={() => scrollToGroup(g.id)}
          >
            <GroupIcon icon={g.icon} />
            <span className={styles.tabLabel}>{g.title}</span>
            {stats?.critical && <CriticalMark reason={stats.criticalReason} />}
            {stats && stats.files > 0 && (
              <DiffStats additions={stats.additions} deletions={stats.deletions} binary={stats.binary === stats.files} />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Starts a full review of the same base and head as this diff run, then opens it. */
function ReviewButton({ run }: { run: RunWithProgress }) {
  const [startRun, { isLoading, error }] = useStartRunMutation();
  const navigate = useNavigate();
  const onClick = async () => {
    const res = await startRun({ kind: "review", fromRun: run.id });
    if ("data" in res && res.data) void navigate({ to: "/runs/$runId", params: { runId: res.data.id } });
  };
  return (
    <>
      <button
        type="button"
        className={styles.action}
        disabled={isLoading || run.status === "running"}
        onClick={() => void onClick()}
        title="Start a full review of this base and head"
      >
        {isLoading ? "Starting review…" : "Review these changes"}
      </button>
      {error && <span className={styles.actionError}>{errorMessage(error)}</span>}
    </>
  );
}

interface HeaderProps {
  run: RunWithProgress;
  tree: GroupTree;
  visible: ReadonlySet<string>;
  collapseActions: readonly CollapseAction[];
}

export function Header({ run, tree, visible, collapseActions }: HeaderProps) {
  const wide = useMediaQuery(WIDE_QUERY);
  const sidebar = useAppSelector(selectSidebar);
  const { ref, hidden, scrolled } = useStickyHeader(wide);
  const target = run.target;
  const totals = run.files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );
  const baseRef = target.kind === "pr" ? target.baseRef : shortSha(run.base);
  const headRef = target.kind === "pr" ? target.headRef : shortSha(run.head);
  const cost = run.status === "running" ? (run.progress?.costUsd ?? 0) : run.meta.costUsd;
  const isDiff = runKind(run) === "diff";

  return (
    <header ref={ref} data-app-header className={styles.header} data-hidden={hidden} data-scrolled={scrolled}>
      <div className={styles.inner}>
        <div className={styles.row}>
          <Link to="/" className={styles.home} title="All runs">
            <PhHouse aria-hidden />
          </Link>
          <StatusBadge status={run.status} compact />
          <h1 className={styles.title}>
            {target.kind === "pr" ? (
              <a href={target.url} target="_blank" rel="noreferrer">
                {formatTarget(target)}
              </a>
            ) : (
              formatTarget(target)
            )}
          </h1>
          <ViewControls collapseActions={collapseActions} wide={wide} />
        </div>
        <div className={styles.meta}>
          {target.kind === "pr" && <span className={styles.author}>{target.author}</span>}
          <span className={styles.refs}>
            <code className={styles.ref} title={run.base}>
              {baseRef}
            </code>
            <span aria-label="from">←</span>
            <code className={styles.ref} title={run.head}>
              {headRef}
            </code>
          </span>
          <span>{plural(run.files.length, "file")}</span>
          <DiffStats additions={totals.additions} deletions={totals.deletions} />
          <span className={styles.right}>
            {isDiff && !run.repo.remote && <ReviewButton run={run} />}
            <span title={run.repo.root}>{run.repo.slug ?? run.repo.root}</span>
            <span>{formatRelative(run.createdAt)}</span>
            {(!isDiff || cost > 0) && <span title="Model cost">{formatCost(cost)}</span>}
          </span>
        </div>
        {run.status === "running" && <ProgressStrip progress={run.progress} />}
        {run.status === "failed" && run.error && (
          <p className={styles.error}>
            {isDiff ? "Run" : "Review"} failed: {run.error}
          </p>
        )}
        {(!wide || !sidebar) && <GroupTabs tree={tree} visible={visible} />}
      </div>
    </header>
  );
}
