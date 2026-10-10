import { useEffect } from "react";

const positions = new Map<string, number>();

function entryKey(): string | undefined {
  const state: unknown = history.state;
  if (state && typeof state === "object" && "__TSR_key" in state && typeof state.__TSR_key === "string") {
    return state.__TSR_key;
  }
  return undefined;
}

/**
 * True when the current history entry was already scrolled on this page load,
 * which means the reader came back to it with Back/Forward. The router updates
 * the location before `popstate` fires, so that event is too late to tell.
 */
export function revisitingEntry(): boolean {
  const key = entryKey();
  return key !== undefined && positions.has(key);
}

/**
 * Remembers the window scroll position of each history entry and restores it
 * on Back/Forward, a few frames in a row because the virtualizer can change
 * heights above the target while it renders.
 */
export function useHistoryScroll(): void {
  useEffect(() => {
    const onScroll = () => {
      const key = entryKey();
      if (key) positions.set(key, window.scrollY);
    };
    const onPop = () => {
      const key = entryKey();
      const top = key ? positions.get(key) : undefined;
      if (top === undefined) return;
      let frames = 0;
      const step = () => {
        window.scrollTo({ top, behavior: "instant" });
        if (++frames < 4) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("popstate", onPop);
    };
  }, []);
}
