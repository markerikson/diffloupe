import PhCircleNotch from "~icons/ph/circle-notch";
import type { ReviewStage } from "../../server/types.ts";
import { runKind } from "../../types/review-run.ts";
import type { RunWithProgress } from "../store/api.ts";
import { SUMMARY_ID } from "./SummaryBlock.tsx";
import styles from "./AnalysisProgress.module.css";

const STAGES: Record<ReviewStage, { title: string; detail: string }> = {
  resolving_target: { title: "Preparing the changes", detail: "Loading the diff and checking what changed." },
  checking_registry: { title: "Checking review history", detail: "Looking for earlier findings so this review can focus on what is new." },
  building_map: { title: "Understanding the repository", detail: "Mapping the code around the changed files." },
  grouping: { title: "Grouping related changes", detail: "Organizing the files into focused review groups." },
  reviewing: { title: "Reviewing the changes", detail: "Analyzing each group for issues and checking the surrounding code." },
  coordinating: { title: "Summarizing the review", detail: "Combining findings and preparing a walkthrough of the changes." },
  walkthrough: { title: "Preparing the walkthrough", detail: "Organizing the results and explaining how the changes fit together." },
  verifying: { title: "Verifying the findings", detail: "Checking the findings and their locations in the diff." },
  writing: { title: "Saving the results", detail: "Finishing the review report. It will appear here automatically." },
};

/** A running review has progress, not an empty findings summary. */
export function AnalysisProgress({ run }: { run: RunWithProgress }) {
  const { progress: p } = run;
  const isDiff = runKind(run) === "diff";
  const stage = p?.stage ? STAGES[p.stage] : {
    title: isDiff ? "Preparing the diff" : "Starting the review",
    detail: "Waiting for the first progress update. This page updates automatically.",
  };
  const finished = p ? p.slicesDone + p.slicesFailed : 0;
  const showSlices = p?.stage === "reviewing" && p.slicesTotal > 0;

  return (
    <section id={SUMMARY_ID} tabIndex={-1} className={styles.panel} aria-labelledby="analysis-heading">
      <div className={styles.status} role="status" aria-live="polite" aria-atomic="true">
        <PhCircleNotch className={styles.spinner} aria-hidden />
        <div>
          <p className={styles.eyebrow}>{isDiff ? "Diff in progress" : "Analysis in progress"}</p>
          <h2 id="analysis-heading" className={styles.heading}>{stage.title}</h2>
          <p className={styles.detail}>{stage.detail}</p>
        </div>
      </div>
      {showSlices && (
        <div className={styles.reviewProgress}>
          <div className={styles.counts}>
            <span>{finished} of {p.slicesTotal} review groups processed</span>
            {p.slicesFailed > 0 && <span className={styles.failed}>{p.slicesFailed} failed</span>}
          </div>
          <progress className={styles.bar} value={finished} max={p.slicesTotal} aria-label="Review groups processed" />
          {p.activeSlices.length > 0 && (
            <div className={styles.active}>
              <p className={styles.label}>Currently reviewing</p>
              <ul>{p.activeSlices.map((title, index) => <li key={`${index}-${title}`}>{title}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {p?.lastMessage && <p className={styles.message}><span className={styles.label}>Latest update</span>{p.lastMessage}</p>}
      <p className={styles.hint}>You can browse the diff below while {isDiff ? "the walkthrough is prepared" : "the analysis runs"}. Results appear automatically.</p>
    </section>
  );
}
