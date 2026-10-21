import { useVirtualizer } from "@pierre/diffs/react";
import { Link } from "@tanstack/react-router";
import { memo, useEffect, useState } from "react";
import { findingMarkdown } from "../../review/export.ts";
import { DISMISS_REASONS, type DismissReason, type FindingStatus, type RunFinding } from "../../types/review-run.ts";
import { useChangeRunState, useRunState } from "../hooks/useRunState.ts";
import { anchorNote } from "../lib/annotations.ts";
import { useGetRunQuery } from "../store/api.ts";
import { SEVERITY_LABEL } from "../lib/format.ts";
import { useRunNav } from "../lib/run-nav.ts";
import { selectFocusedFinding } from "../store/focus.ts";
import { useAppSelector } from "../store/hooks.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Markdown } from "./Markdown.tsx";
import styles from "./FindingCard.module.css";

const REASON_LABEL: Record<DismissReason, string> = {
  wrong: "Wrong",
  "not-worth-fixing": "Not worth fixing",
  "already-handled": "Already handled",
  duplicate: "Duplicate",
  other: "Other",
};

/** Accept or dismiss buttons, the dismiss reason form, or the current status with a way back to open. */
function TriageBar({ finding }: { finding: RunFinding }) {
  const { runId } = useRunNav();
  const state = useRunState(runId);
  const change = useChangeRunState(runId);
  const running = useGetRunQuery(runId).data?.status === "running";
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState<DismissReason>("wrong");
  const [note, setNote] = useState("");
  const virtualizer = useVirtualizer();
  useEffect(() => {
    virtualizer?.markDOMDirty();
  }, [dismissing, virtualizer]);
  const status = state.findingStatus[finding.id] ?? "open";
  const saved = state.findingNotes?.[finding.id];

  const set = (next: FindingStatus, extra: { reason?: DismissReason; note?: string } = {}) => {
    change({ op: "finding", ids: [finding.id], status: next, ...extra, at: new Date().toISOString() });
    setDismissing(false);
  };
  const title = running ? "Available when the run finishes" : undefined;

  if (dismissing) {
    return (
      <form
        className={styles.triage}
        onSubmit={(e) => {
          e.preventDefault();
          set("dismissed", { reason, ...(note.trim() ? { note: note.trim() } : {}) });
        }}
      >
        <select aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value as DismissReason)}>
          {DISMISS_REASONS.map((r) => (
            <option key={r} value={r}>
              {REASON_LABEL[r]}
            </option>
          ))}
        </select>
        <input aria-label="Note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="submit">Dismiss</button>
        <button type="button" onClick={() => setDismissing(false)}>
          Cancel
        </button>
      </form>
    );
  }

  if (status !== "open") {
    return (
      <div className={styles.triage}>
        <span className={styles.status}>
          {status === "accepted" ? "Accepted" : `Dismissed: ${REASON_LABEL[saved?.reason ?? "other"]}`}
        </span>
        {saved?.note && <span>{saved.note}</span>}
        <button type="button" disabled={running} title={title} onClick={() => set("open")}>
          Reopen
        </button>
      </div>
    );
  }

  return (
    <div className={styles.triage}>
      <button type="button" disabled={running} title={title ?? "Mark this finding worth fixing"} onClick={() => set("accepted")}>
        Accept
      </button>
      <button
        type="button"
        disabled={running}
        title={title ?? "Dismiss this finding with a reason"}
        onClick={() => setDismissing(true)}
      >
        Dismiss
      </button>
    </div>
  );
}

interface FindingCardProps {
  finding: RunFinding;
  overCap: boolean;
}

export const FindingCard = memo(function FindingCard({ finding, overCap }: FindingCardProps) {
  const nav = useRunNav();
  const virtualizer = useVirtualizer();
  const state = useRunState(nav.runId);
  const status = state.findingStatus[finding.id] ?? "open";
  const focused = useAppSelector(selectFocusedFinding) === finding.id;
  const [open, setOpen] = useState(false);
  const expanded = open || focused;
  useEffect(() => {
    virtualizer?.markDOMDirty();
  }, [expanded, status, virtualizer]);

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
      data-status={status}
      aria-label={`${SEVERITY_LABEL[finding.severity]}: ${finding.title}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, select, input")) return;
        if (!focused) nav.goToFinding(finding.id, { scroll: false });
      }}
    >
      <header className={styles.head}>
        <span className={styles.severity}>{SEVERITY_LABEL[finding.severity]}</span>
        <h3 className={styles.title}>{finding.title}</h3>
        <CopyButton label="Copy" title="Copy this finding as Markdown" text={() => findingMarkdown(finding, state)} />
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
      <TriageBar finding={finding} />
    </article>
  );
});
