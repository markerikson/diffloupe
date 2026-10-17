import { useVirtualizer } from "@pierre/diffs/react";
import { Link } from "@tanstack/react-router";
import { memo, useEffect, useState } from "react";
import { findingMarkdown } from "../../review/export.ts";
import type { RunFinding } from "../../types/review-run.ts";
import { anchorNote } from "../lib/annotations.ts";
import { SEVERITY_LABEL } from "../lib/format.ts";
import { useRunNav } from "../lib/run-nav.ts";
import { selectFocusedFinding } from "../store/focus.ts";
import { useAppSelector } from "../store/hooks.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Markdown } from "./Markdown.tsx";
import styles from "./FindingCard.module.css";

interface FindingCardProps {
  finding: RunFinding;
  overCap: boolean;
}

export const FindingCard = memo(function FindingCard({ finding, overCap }: FindingCardProps) {
  const nav = useRunNav();
  const virtualizer = useVirtualizer();
  const focused = useAppSelector(selectFocusedFinding) === finding.id;
  const [open, setOpen] = useState(false);
  const expanded = open || focused;
  useEffect(() => {
    virtualizer?.markDOMDirty();
  }, [expanded, virtualizer]);

  const note = anchorNote(finding.anchor);
  const hasDetails = Boolean(finding.impact || finding.evidence || finding.suggestion || finding.suggestedCode);

  return (
    <article
      id={`finding-${finding.id}`}
      tabIndex={-1}
      className={styles.card}
      data-severity={finding.severity}
      data-focused={focused}
      data-preexisting={finding.preexisting ?? false}
      aria-label={`${SEVERITY_LABEL[finding.severity]}: ${finding.title}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        if (!focused) nav.goToFinding(finding.id, { scroll: false });
      }}
    >
      <header className={styles.head}>
        <span className={styles.severity}>{SEVERITY_LABEL[finding.severity]}</span>
        <h3 className={styles.title}>{finding.title}</h3>
        <CopyButton label="Copy" title="Copy this finding as Markdown" text={() => findingMarkdown(finding)} />
      </header>
      <div className={styles.meta}>
        <span>{finding.category}</span>
        <span>{finding.confidence} confidence</span>
        {finding.preexisting && (
          <span className={styles.badge} title="The problem is in code this change did not add or modify">
            pre-existing
          </span>
        )}
        {overCap && <span className={styles.badge}>over the posting cap</span>}
        {finding.carriedFrom && (
          <Link to="/runs/$runId" params={{ runId: finding.carriedFrom }} className={styles.badge}>
            from earlier run
          </Link>
        )}
        {finding.repeatOf !== undefined && <span className={styles.badge}>repeats comment #{finding.repeatOf}</span>}
      </div>
      {note && <p className={styles.note}>{note}</p>}
      <Markdown source={finding.explanation} className={styles.body} />
      {hasDetails && expanded && (
        <div className={styles.details}>
          {finding.impact && (
            <section>
              <h4>Impact</h4>
              <Markdown source={finding.impact} />
            </section>
          )}
          {finding.evidence && (
            <section>
              <h4>Evidence</h4>
              <Markdown source={finding.evidence} />
            </section>
          )}
          {(finding.suggestion || finding.suggestedCode) && (
            <section>
              <h4>Suggestion</h4>
              {finding.suggestion && <Markdown source={finding.suggestion} />}
              {finding.suggestedCode && (
                <pre className={styles.code}>
                  <code>{finding.suggestedCode}</code>
                </pre>
              )}
            </section>
          )}
        </div>
      )}
      {hasDetails && !focused && (
        <button type="button" className={styles.more} onClick={() => setOpen(!open)} aria-expanded={expanded}>
          {expanded ? "Hide details" : "Show details"}
        </button>
      )}
    </article>
  );
});
