import { Link } from "@tanstack/react-router";
import PhTrash from "~icons/ph/trash";
import type { FindingSeverity, RunHeader } from "../../types/review-run.ts";
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

function RunRow({ run }: { run: RunHeader }) {
  const [deleteRun, { isLoading: deleting }] = useDeleteRunMutation();
  const title = formatTarget(run.target);
  const onDelete = () => {
    if (window.confirm(`Delete run ${run.id}?`)) void deleteRun(run.id);
  };
  return (
    <tr className={styles.row}>
      <td>
        <StatusBadge status={run.status} />
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
      {SEVERITIES.map(({ key }) => (
        <td key={key} className={styles.count} data-severity={key} data-zero={run.findingCounts[key] === 0}>
          {run.findingCounts[key]}
        </td>
      ))}
      <td className={styles.count}>{formatCost(run.costUsd)}</td>
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
  const { data: runs, error, isFetching } = useListRunsQuery();
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>DiffLoupe</h1>
        <span className={styles.muted}>{isFetching ? "Refreshing…" : runs ? `${runs.length} runs` : ""}</span>
      </header>
      {error ? (
        <p className={styles.error}>{errorMessage(error)}</p>
      ) : runs && runs.length === 0 ? (
        <p className={styles.muted}>
          No runs yet. Start one with <code>diffloupe review</code>.
        </p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Status</th>
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
