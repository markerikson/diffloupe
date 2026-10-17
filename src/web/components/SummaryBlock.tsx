import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { Verdict } from "../../review/core/verdict.ts";
import { runMarkdown } from "../../review/export.ts";
import { runKind, type ReviewRun, type RunFinding } from "../../types/review-run.ts";
import { byFile, type FileFindings, summarizeFindings } from "../lib/finding-summary.ts";
import { SEVERITY_LABEL, formatCost, formatDuration, plural } from "../lib/format.ts";
import { intentSource } from "../lib/intent-source.ts";
import { useRunNav } from "../lib/run-nav.ts";
import { overCapToggled, selectShowOverCap } from "../store/focus.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Markdown } from "./Markdown.tsx";
import styles from "./SummaryBlock.module.css";

export const SUMMARY_ID = "summary";

const ALIGNMENT_LABEL = {
  aligned: (source: string) => `Matches ${source}`,
  partial: (source: string) => `Partly matches ${source}`,
  misaligned: (source: string) => `Does not match ${source}`,
} as const;

const INTENT_LISTS = [
  ["matches", () => "Holds up on"],
  ["mismatches", () => "Does not hold up on"],
  ["unstated", (source: string) => `In the diff but not in ${source}`],
  ["missing", () => "Stated but not accomplished"],
] as const;

function capitalize(phrase: string): string {
  const s = phrase.replace(/^the /, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const UNREVIEWED = [
  ["overCap", "More code files than the reviewers could read; these were left out."],
  ["failed", "The reviewer for these files failed."],
  ["budget", "The cost limit stopped the review before these files."],
] as const;

function FileLink({ path, known }: { path: string; known: boolean }) {
  const nav = useRunNav();
  if (!known) return <code className={styles.path}>{path}</code>;
  return (
    <button type="button" className={styles.fileLink} onClick={() => nav.goToFile(path)}>
      <code className={styles.path}>{path}</code>
    </button>
  );
}

function VerdictLine({ verdict }: { verdict: Verdict }) {
  return (
    <p className={styles.verdict}>
      <span className={styles.dot} data-level={verdict.level} aria-hidden />
      <strong>{verdict.label}</strong> — {verdict.detail}
    </p>
  );
}

function lineLabel(f: RunFinding): string {
  const a = f.anchor;
  const start = a.kind === "line" ? a.line : a.cited.line;
  const end = a.kind === "line" ? a.endLine : a.cited.endLine;
  if (!start) return "whole file";
  return end && end !== start ? `L${start}-${end}` : `L${start}`;
}

function FindingList({ groups, files }: { groups: FileFindings[]; files: ReadonlySet<string> }) {
  const nav = useRunNav();
  return (
    <ul className={styles.findings}>
      {groups.map(({ file, findings }) => {
        const inDiff = files.has(file);
        return (
          <li key={file}>
            <FileLink path={file} known={inDiff} />
            {!inDiff && <span className={styles.outside}>outside the diff</span>}
            <ul className={styles.fileFindings}>
              {findings.map((f) => (
                <li key={f.id} className={styles.finding}>
                  <span className={styles.dot} data-severity={f.severity} aria-hidden />
                  <strong>{SEVERITY_LABEL[f.severity]}</strong> {f.title} —{" "}
                  {inDiff ? (
                    <button type="button" className={styles.lineLink} onClick={() => nav.goToFinding(f.id)}>
                      {lineLabel(f)}
                    </button>
                  ) : (
                    <span>{lineLabel(f)}</span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.labelled}>
      <strong>{label}</strong> {children}
    </div>
  );
}

export function SummaryBlock({ run }: { run: ReviewRun }) {
  const dispatch = useAppDispatch();
  const showOverCap = useAppSelector(selectShowOverCap);
  const files = new Set(run.files.map((f) => f.path));
  const summary = summarizeFindings(run);
  const { intent, overview, meta } = run;
  const reportedCount = summary.main.length + summary.other.length;
  const mainCount = summary.main.reduce((n, g) => n + g.findings.length, 0);
  const otherCount = summary.other.reduce((n, g) => n + g.findings.length, 0);
  const preexistingCount = summary.preexisting.reduce((n, g) => n + g.findings.length, 0);
  const overCap = run.overCapFindings;
  // With nothing stated to compare against, only the inferred intent means anything.
  const source = intentSource(run);
  const alignment = source ? intent.alignment : undefined;
  const intentLists = source ? INTENT_LISTS.filter(([key]) => (intent[key]?.length ?? 0) > 0) : [];
  const unreviewed = UNREVIEWED.filter(([key]) => (run.unreviewed[key]?.length ?? 0) > 0);
  const oneLine = source ? intent.mismatches?.[0] : undefined;
  const isDiff = runKind(run) === "diff";
  const groupCount = run.groups.filter((g) => g.files.length > 0).length;

  return (
    <section
      id={SUMMARY_ID}
      tabIndex={-1}
      className={styles.summary}
      aria-label={isDiff ? "Diff summary" : "Review summary"}
    >
      {isDiff ? (
        <p>
          {plural(run.files.length, "changed file")} in {plural(groupCount, "group")}
          {run.status === "complete" && run.stops.length === 0 && !overview.focus && (
            <span className={styles.note}> · no walkthrough (add one with <code>diffloupe diff --walkthrough</code>)</span>
          )}
        </p>
      ) : reportedCount === 0 ? (
        <p>
          {run.status === "running"
            ? "Reviewing the changed files. Findings appear here when the review finishes."
            : run.status === "complete"
              ? "No new issues found in the changed files."
              : `The review ${run.status === "failed" ? "failed" : "was cancelled"} before reporting any findings.`}
        </p>
      ) : (
        <div className={styles.verdicts}>
          <VerdictLine verdict={summary.merge} />
          {summary.prod && <VerdictLine verdict={summary.prod} />}
          <p className={styles.counts}>
            {summary.counts.map(([severity, n], i) => (
              <span key={severity}>
                {i > 0 && <span className={styles.sep}> · </span>}
                <span className={styles.dot} data-severity={severity} aria-hidden />
                <strong>{SEVERITY_LABEL[severity]}</strong>: {n}
              </span>
            ))}
          </p>
        </div>
      )}

      {mainCount > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.heading}>
              {summary.title} ({mainCount})
            </h3>
            <CopyButton
              text={() => runMarkdown(run, { includeOverCap: showOverCap })}
              label="Copy all"
              title="Copy all findings as markdown"
            />
          </div>
          <FindingList groups={summary.main} files={files} />
        </section>
      )}

      {otherCount > 0 && (
        <details className={styles.details}>
          <summary>Everything else ({otherCount}) — lower-risk surfaces</summary>
          <FindingList groups={summary.other} files={files} />
        </details>
      )}

      {preexistingCount > 0 && (
        <details className={styles.details}>
          <summary>Pre-existing ({preexistingCount}) — not introduced by this change</summary>
          <FindingList groups={summary.preexisting} files={files} />
        </details>
      )}

      {overCap.length > 0 && (
        <div className={styles.section}>
          <label className={styles.overCap}>
            <input type="checkbox" checked={showOverCap} onChange={() => dispatch(overCapToggled())} />
            {plural(overCap.length, "more finding")} past the posting cap. Show them here and in the diff.
          </label>
          {showOverCap && (
            <FindingList groups={byFile(overCap)} files={files} />
          )}
        </div>
      )}

      {summary.echoed.length > 0 && (
        <details className={styles.details}>
          <summary>Agreeing with {plural(summary.echoed.length, "existing review comment")}</summary>
          <FindingList groups={byFile(summary.echoed)} files={files} />
        </details>
      )}

      {(alignment || intent.inferred || intent.stated || intentLists.length > 0) && (
        <div className={styles.section}>
          {source && (alignment || oneLine) && (
            <Labelled label="Intent:">
              {alignment && (
                <span className={styles.alignment} data-alignment={alignment}>
                  {ALIGNMENT_LABEL[alignment](source)}
                </span>
              )}
              {oneLine && <> — {oneLine}</>}
            </Labelled>
          )}
          {intent.inferred && <Labelled label="What it does:">{intent.inferred}</Labelled>}
          {source && (intent.stated || intentLists.length > 0) && (
            <details className={styles.details}>
              <summary>{capitalize(source)} compared with the code</summary>
              {intent.stated && <Labelled label="Stated:">{intent.stated}</Labelled>}
              {intentLists.map(([key, title]) => (
                <div key={key}>
                  <h4 className={styles.subheading}>{title(source)}</h4>
                  <ul className={styles.list}>
                    {(intent[key] ?? []).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </details>
          )}
        </div>
      )}

      {overview.focus && (
        <div className={styles.labelled}>
          <strong>What to focus on:</strong> <Markdown source={overview.focus} className={styles.inline} />
        </div>
      )}

      {overview.startHere.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Start here</h3>
          <ol className={styles.list}>
            {overview.startHere.map((s) => (
              <li key={s.file}>
                <FileLink path={s.file} known={files.has(s.file)} /> — {s.why}
              </li>
            ))}
          </ol>
        </section>
      )}

      {run.resolved.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Fixed since the last run</h3>
          <ul className={styles.list}>
            {run.resolved.map((r) => (
              <li key={r.id}>
                {run.priorRunId ? (
                  <Link to="/runs/$runId" params={{ runId: run.priorRunId }} search={{ finding: r.id }}>
                    {r.title ?? r.id}
                  </Link>
                ) : (
                  (r.title ?? r.id)
                )}
                {r.file && <code className={styles.path}> {r.file}</code>}
                {r.note && <span className={styles.why}>{r.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {unreviewed.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Not reviewed</h3>
          {unreviewed.map(([key, note]) => (
            <div key={key}>
              <p className={styles.note}>{note}</p>
              <ul className={styles.files}>
                {(run.unreviewed[key] ?? []).map((path) => (
                  <li key={path}>
                    <FileLink path={path} known={files.has(path)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      <footer className={styles.footer}>
        {overview.changeType && <span>{overview.changeType}</span>}
        {meta.costUsd > 0 || (run.status === "running" && !isDiff) ? (
          <span>{formatCost(meta.costUsd)}</span>
        ) : (
          !isDiff && <span>cost not reported</span>
        )}
        {meta.wallMs > 0 && <span>{formatDuration(meta.wallMs)}</span>}
        {meta.model && <span>{meta.effort ? `${meta.model} (${meta.effort})` : meta.model}</span>}
        <span>{run.status}</span>
      </footer>
    </section>
  );
}
