import { useVirtualizer } from "@pierre/diffs/react";
import { memo, useEffect } from "react";
import PhArrowLeft from "~icons/ph/arrow-left";
import PhArrowRight from "~icons/ph/arrow-right";
import PhSignpost from "~icons/ph/signpost";
import type { GuideStop } from "../../types/review-run.ts";
import { anchorNote } from "../lib/annotations.ts";
import { useRunNav } from "../lib/run-nav.ts";
import { selectFocusedStop, selectStopLocation } from "../store/focus.ts";
import { useAppSelector } from "../store/hooks.ts";
import { Markdown } from "./Markdown.tsx";
import styles from "./GuideCard.module.css";

interface GuideCardProps {
  stop: GuideStop;
  location: number;
}

export const GuideCard = memo(function GuideCard({ stop, location }: GuideCardProps) {
  const nav = useRunNav();
  const virtualizer = useVirtualizer();
  const focused = useAppSelector((s) => selectFocusedStop(s) === stop.id && selectStopLocation(s) === location);
  useEffect(() => {
    virtualizer?.markDOMDirty();
  }, [focused, virtualizer]);

  const index = nav.stops.findIndex((s) => s.id === stop.id);
  const prev = nav.stops[index - 1];
  const next = nav.stops[index + 1];
  const loc = stop.locations[location];
  const note = loc ? anchorNote(loc) : undefined;
  const many = stop.locations.length > 1;

  return (
    <aside
      id={`stop-${stop.id}-${location}`}
      tabIndex={-1}
      className={styles.card}
      data-importance={stop.importance}
      data-focused={focused}
      aria-label={`Walkthrough stop ${index + 1} of ${nav.stops.length}: ${stop.title}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        if (!focused) nav.goToStop(stop.id, location, { scroll: false });
      }}
    >
      <header className={styles.head}>
        <PhSignpost aria-hidden className={styles.icon} />
        <span className={styles.kicker}>
          Stop {index + 1} of {nav.stops.length}
        </span>
        <h3 className={styles.title}>{stop.title}</h3>
        {stop.importance !== "normal" && <span className={styles.importance}>{stop.importance}</span>}
      </header>
      {loc?.label && <p className={styles.label}>{loc.label}</p>}
      {note && <p className={styles.note}>{note}</p>}
      {stop.prose && <Markdown source={stop.prose} className={styles.body} />}
      <nav className={styles.nav} aria-label="Walkthrough">
        <button type="button" disabled={!prev} onClick={() => prev && nav.goToStop(prev.id)}>
          <PhArrowLeft aria-hidden /> Previous stop
        </button>
        {many && (
          <button
            type="button"
            onClick={() => nav.goToStop(stop.id, (location + 1) % stop.locations.length)}
            title={`Location ${location + 1} of ${stop.locations.length}`}
          >
            Next location ({location + 1}/{stop.locations.length})
          </button>
        )}
        <button type="button" disabled={!next} onClick={() => next && nav.goToStop(next.id)}>
          Next stop <PhArrowRight aria-hidden />
        </button>
      </nav>
    </aside>
  );
});
