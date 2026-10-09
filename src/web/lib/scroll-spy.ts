import { useEffect, useState } from "react";

export interface SectionRect {
  id: string;
  top: number;
  bottom: number;
}

export interface FileMarker {
  path: string;
  top: number;
}

/** Ids of sections that show at least one pixel below the sticky header. */
export function visibleGroups(rects: readonly SectionRect[], headerBottom: number, viewportHeight: number): string[] {
  return rects.filter((r) => r.bottom > headerBottom && r.top < viewportHeight).map((r) => r.id);
}

/**
 * The file at the top of the visible part of a section: the one whose span
 * (its marker to the next marker, the last one to the section bottom) holds
 * the line just below the header. Before the first marker reaches the
 * header, that is the first file.
 */
export function visibleFile(markers: readonly FileMarker[], sectionBottom: number, headerBottom: number): string | null {
  if (markers.length === 0 || sectionBottom <= headerBottom) return null;
  let current = markers[0]!;
  for (const m of markers) {
    if (m.top > headerBottom) break;
    current = m;
  }
  return current.path;
}

export interface ScrollSpyState {
  groups: string[];
  /** Visible file per visible section that has files. */
  files: Record<string, string>;
}

const EMPTY: ScrollSpyState = { groups: [], files: {} };
export const HEADER_SELECTOR = "[data-app-header]";
export const SECTION_SELECTOR = "[data-group-section]";
export const FILE_MARKER_SELECTOR = "[data-file-start]";

/** Bottom edge of the sticky header, 0 while it is scrolled out of view. */
export function headerBottom(): number {
  const el = document.querySelector(HEADER_SELECTOR);
  return el ? Math.max(0, el.getBoundingClientRect().bottom) : 0;
}

function measure(): ScrollSpyState {
  const top = headerBottom();
  const viewport = window.innerHeight;
  const sections = [...document.querySelectorAll<HTMLElement>(SECTION_SELECTOR)];
  const rects = sections.map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.groupSection ?? "", top: r.top, bottom: r.bottom, el };
  });
  const groups = visibleGroups(rects, top, viewport);
  const files: Record<string, string> = {};
  for (const r of rects) {
    if (!groups.includes(r.id)) continue;
    const markers = [...r.el.querySelectorAll<HTMLElement>(FILE_MARKER_SELECTOR)].map((m) => ({
      path: m.dataset.path ?? "",
      top: m.getBoundingClientRect().top,
    }));
    const path = visibleFile(markers, r.bottom, top);
    if (path !== null) files[r.id] = path;
  }
  return { groups, files };
}

const same = (a: ScrollSpyState, b: ScrollSpyState) =>
  a.groups.length === b.groups.length &&
  a.groups.every((g, i) => g === b.groups[i]) &&
  Object.keys(a.files).length === Object.keys(b.files).length &&
  Object.entries(a.files).every(([k, v]) => b.files[k] === v);

/**
 * Tracks which group sections and files are on screen. Listens to scroll in
 * the capture phase so nested scrollers count too, measures once per frame,
 * and only sets state when the answer changes. A new `key` re-measures.
 */
export function useScrollSpy(enabled: boolean, key?: unknown): ScrollSpyState {
  const [state, setState] = useState<ScrollSpyState>(EMPTY);

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = measure();
      setState((prev) => (same(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    schedule();
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    return () => {
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [enabled, key]);

  return state;
}
