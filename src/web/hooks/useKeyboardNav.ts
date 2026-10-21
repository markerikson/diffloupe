import { useEffect, useRef } from "react";
import { currentFileAtTop, scrollToFile } from "../lib/navigate.ts";
import { type NavLists, neighbor } from "../lib/navigation.ts";
import type { RunNav } from "../lib/run-nav.ts";
import { api } from "../store/api.ts";
import { helpSet } from "../store/focus.ts";
import { useAppStore } from "../store/hooks.ts";
import { fileCollapseToggled, selectCollapsedFiles } from "../store/view.ts";

export type KeyAction =
  | "nextFile"
  | "prevFile"
  | "nextFinding"
  | "prevFinding"
  | "nextStop"
  | "prevStop"
  | "toggleFile"
  | "toggleReviewed"
  | "top"
  | "help";

const ACTIONS: Record<string, KeyAction> = {
  j: "nextFile",
  k: "prevFile",
  n: "nextFinding",
  p: "prevFinding",
  "]": "nextStop",
  "[": "prevStop",
  x: "toggleFile",
  r: "toggleReviewed",
  t: "top",
  "?": "help",
};

interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

interface EditableLike {
  tagName?: string;
  isContentEditable?: boolean;
}

export function isEditable(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as EditableLike;
  return el.isContentEditable === true || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/** The shortcut a keydown maps to, or null when it should pass through. */
export function keyAction(e: KeyInput): KeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return null;
  return ACTIONS[e.key] ?? null;
}

/**
 * The id after or before `current`. With no current id, picks the first item at
 * or after the file at the top of the screen (or the last before it, going back).
 */
function step<T extends { id: string }>(
  items: readonly T[],
  current: string | null,
  dir: 1 | -1,
  fileIndex: (item: T) => number,
  topIndex: number | undefined,
): string | undefined {
  const ids = items.map((i) => i.id);
  if (current && ids.includes(current)) return neighbor(ids, current, dir);
  if (topIndex === undefined) return dir === 1 ? ids[0] : undefined;
  if (dir === 1) return items.find((i) => fileIndex(i) >= topIndex)?.id;
  return items.filter((i) => fileIndex(i) < topIndex).at(-1)?.id;
}

/** One document keydown listener for the run page shortcuts. */
export function useKeyboardNav(lists: NavLists | null, nav: RunNav, runId: string): void {
  const store = useAppStore();
  const live = useRef({ lists, nav });
  live.current = { lists, nav };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const action = keyAction(e);
      const { lists, nav } = live.current;
      if (!action || !lists) return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();

      const state = store.getState();
      const top = currentFileAtTop();
      const fileIds = lists.files.map((f) => f.path);
      const topIndex = top ? fileIds.indexOf(top.path) : undefined;
      const indexOf = (path: string) => fileIds.indexOf(path);
      const dir = action.startsWith("next") ? 1 : -1;

      switch (action) {
        case "nextFile":
        case "prevFile": {
          const path = top ? neighbor(fileIds, top.path, dir) : dir === 1 ? fileIds[0] : undefined;
          if (path) nav.goToFile(path);
          return;
        }
        case "nextFinding":
        case "prevFinding": {
          const id = step(lists.findings, state.focus.finding, dir, (f) => indexOf(f.anchor.file), topIndex);
          if (id) nav.goToFinding(id);
          return;
        }
        case "nextStop":
        case "prevStop": {
          // Stops follow guide order, not page order, so with none focused `]` starts at the first stop.
          const id = step(lists.stops, state.focus.stop, dir, () => 0, undefined);
          if (id) nav.goToStop(id);
          return;
        }
        case "toggleFile": {
          const path = top?.path ?? state.focus.file;
          if (!path) return;
          const wasCollapsed = selectCollapsedFiles(state, runId)?.includes(path) ?? false;
          store.dispatch(fileCollapseToggled({ runId, path }));
          const groupId = top?.groupId ?? lists.files.find((f) => f.path === path)?.groupId;
          if (!wasCollapsed && groupId) scrollToFile(groupId, path, { focus: true });
          return;
        }
        case "toggleReviewed": {
          const path = top?.path ?? state.focus.file;
          if (!path) return;
          const reviewed = api.endpoints.getRunState.select(runId)(state).data?.reviewedFiles ?? {};
          nav.setReviewed(path, !(path in reviewed));
          return;
        }
        case "top":
          nav.goToTop();
          return;
        case "help":
          store.dispatch(helpSet(true));
          return;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [store, runId]);
}
