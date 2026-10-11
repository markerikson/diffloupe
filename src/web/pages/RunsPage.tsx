import { Link } from "@tanstack/react-router";
import { useState } from "react";
import PhTrash from "~icons/ph/trash";
import type { FindingSeverity, RunHeader, RunKind } from "../../types/review-run.ts";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { formatCost, formatDate, formatRelative, formatTarget } from "../lib/format.ts";
import { errorMessage } from "../routes/root.tsx";
import { useDeleteRunMutation, useListRunsQuery } from "../store/api.ts";
import styles from "./RunsPage.module.css";

const SEVERITIES: { key: FindingSeverity; label: string }[] = [
  { key: "blocker", label: "Blockers" },
  { key: "should-fix", label: "Should fix" },
  { key: "nice-to-have", label: "Nice to have" },
  { key: "question", label: "Questions" },
];

const KIND_FILTERS: { key: RunKind | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "review", label: "Reviews" },
  { key: "diff", label: "Diffs" },
];

function RunRow({ run }: { run: RunHeader }) {
  const [deleteRun, { isLoading: deleting }] = useDeleteRunMutation();
  const title = formatTarget(run.target);
  const kind = run.kind ?? "review";
  const onDelete = () => {
    if (window.confirm(`Delete run ${run.id}?`)) void deleteRun(run.id);
  };
  return (
    <tr className={styles.row}>
      <td>
        <StatusBadge status={run.status} />
      </td>
      <td>
        <span className={styles.kind} data-kind={kind}>
          {kind === "diff" ? "Diff" : "Review"}
        </span>
      </td>
      <td>
        <div className={styles.target}>
        {run.invalid ? (
          <span title={run.invalid}>
            {title} <span className={styles.invalid}>invalid</span>
          </span>
        ) : (
          <Link to="/runs/$runId" params={{ runId: run.id }} className={styles.link}>
            {title}
          </Link>
        )}
        <span className={styles.repo}>{run.repo.slug ?? run.repo.root}</span>
        </div>
      </td>
      <td title={formatDate(run.createdAt)} className={styles.muted}>
        {formatRelative(run.createdAt)}
      </td>
      {SEVERITIES.map(({ key }) =>
        kind === "diff" ? (
          <td key={key} className={styles.count} data-zero />
        ) : (
          <td key={key} className={styles.count} data-severity={key} data-zero={run.findingCounts[key] === 0}>
            {run.findingCounts[key]}
          </td>
        ),
      )}
      <td className={styles.count}>{kind === "diff" && run.costUsd === 0 ? "" : formatCost(run.costUsd)}</td>
      <td>
        {run.status !== "running" && (
          <button type="button" className={styles.delete} onClick={onDelete} disabled={deleting} title="Delete run">
            <PhTrash aria-label="Delete run" />
          </button>
        )}
      </td>
    </tr>
  );
}

export function RunsPage() {
  const { data: allRuns, error, isFetching } = useListRunsQuery();
  const [filter, setFilter] = useState<RunKind | "all">("all");
  const runs = filter === "all" ? allRuns : allRuns?.filter((r) => (r.kind ?? "review") === filter);
  const hasDiffs = allRuns?.some((r) => r.kind === "diff") ?? false;
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>DiffLoupe</h1>
        <span className={styles.muted}>{isFetching ? "Refreshing…" : runs ? `${runs.length} runs` : ""}</span>
        {hasDiffs && (
          <div className={styles.filters} role="group" aria-label="Show">
            {KIND_FILTERS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={styles.filter}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </header>
      {error ? (
        <p className={styles.error}>{errorMessage(error)}</p>
      ) : allRuns && allRuns.length === 0 ? (
        <p className={styles.muted}>
          No runs yet. Start one with <code>diffloupe diff</code> or <code>diffloupe review</code>.
        </p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Status</th>
              <th>Kind</th>
              <th>Target</th>
              <th>Created</th>
              {SEVERITIES.map(({ key, label }) => (
                <th key={key} className={styles.count} data-severity={key}>
                  {label}
                </th>
              ))}
              <th className={styles.count}>Cost</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {runs?.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
