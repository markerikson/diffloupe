import { useEffect, useRef } from "react";
import type { GuideStop, RunGroup } from "../../types/review-run.ts";
import { keepInView } from "../lib/navigate.ts";
import { useRunNav } from "../lib/run-nav.ts";
import { selectFocusedStop } from "../store/focus.ts";
import { useAppSelector } from "../store/hooks.ts";
import styles from "./GuideList.module.css";

interface Chapter {
  id: string;
  title: string;
  stops: GuideStop[];
}

/** Stops grouped by chapter in guide order; stops with no chapter group go under "Walkthrough". */
export function guideChapters(groups: readonly RunGroup[], stops: readonly GuideStop[]): Chapter[] {
  const titles = new Map(groups.filter((g) => !g.parentId).map((g) => [g.id, g.title]));
  const chapters: Chapter[] = [];
  const byId = new Map<string, Chapter>();
  for (const stop of stops) {
    const id = titles.has(stop.chapterId) ? stop.chapterId : "";
    let chapter = byId.get(id);
    if (!chapter) {
      chapter = { id, title: titles.get(id) ?? "Walkthrough", stops: [] };
      byId.set(id, chapter);
      chapters.push(chapter);
    }
    chapter.stops.push(stop);
  }
  return chapters;
}

interface GuideListProps {
  groups: readonly RunGroup[];
  stops: readonly GuideStop[];
}

export function GuideList({ groups, stops }: GuideListProps) {
  const nav = useRunNav();
  const current = useAppSelector(selectFocusedStop);
  const listRef = useRef<HTMLOListElement>(null);
  const chapters = guideChapters(groups, stops);
  let n = 0;

  useEffect(() => {
    const list = listRef.current;
    const container = list?.closest("nav")?.parentElement?.parentElement;
    const row = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (container && row) keepInView(container, row);
  }, [current]);

  return (
    <ol ref={listRef} className={styles.chapters}>
      {chapters.map((chapter) => (
        <li key={chapter.id || "loose"}>
          <h3 className={styles.chapter}>{chapter.title}</h3>
          <ol className={styles.stops}>
            {chapter.stops.map((stop) => {
              n += 1;
              return (
                <li key={stop.id}>
                  <button
                    type="button"
                    className={styles.stop}
                    data-importance={stop.importance}
                    aria-current={stop.id === current ? "step" : undefined}
                    onClick={() => nav.goToStop(stop.id)}
                  >
                    <span className={styles.number}>{n}</span>
                    <span className={styles.title}>{stop.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </li>
      ))}
    </ol>
  );
}
