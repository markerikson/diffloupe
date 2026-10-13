import { useEffect, useRef } from "react";
import type { RunFinding } from "../../types/review-run.ts";
import { keepInView } from "../lib/navigate.ts";
import { SEVERITY_LABEL } from "../lib/format.ts";
import { useRunNav } from "../lib/run-nav.ts";
import { selectFocusedFinding } from "../store/focus.ts";
import { useAppSelector } from "../store/hooks.ts";
import styles from "./FindingNavList.module.css";

interface FileRun {
  file: string;
  findings: RunFinding[];
}

/** Consecutive findings on the same file, keeping page order. */
function runsByFile(findings: readonly RunFinding[]): FileRun[] {
  const runs: FileRun[] = [];
  for (const f of findings) {
    const last = runs.at(-1);
    if (last?.file === f.anchor.file) last.findings.push(f);
    else runs.push({ file: f.anchor.file, findings: [f] });
  }
  return runs;
}

function lineOf(f: RunFinding): string {
  const a = f.anchor;
  const start = a.kind === "line" ? a.line : a.cited.line;
  return start ? `L${start}` : "file";
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

interface FindingNavListProps {
  /** Findings in page order. */
  findings: readonly RunFinding[];
  overCap: ReadonlySet<string>;
}

/** Sidebar list of findings in page order; stays on screen while the diff scrolls. */
export function FindingNavList({ findings, overCap }: FindingNavListProps) {
  const nav = useRunNav();
  const current = useAppSelector(selectFocusedFinding);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const container = list?.closest("nav")?.parentElement?.parentElement;
    const row = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (container && row) keepInView(container, row);
  }, [current]);

  if (findings.length === 0) return <p className={styles.empty}>No findings in the changed files.</p>;

  return (
    <ol ref={listRef} className={styles.files}>
      {runsByFile(findings).map((run, i) => (
        <li key={`${run.file}-${i}`}>
          <button type="button" className={styles.file} title={run.file} onClick={() => nav.goToFile(run.file)}>
            {basename(run.file)}
          </button>
          <ol className={styles.findings}>
            {run.findings.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className={styles.finding}
                  data-severity={f.severity}
                  data-over-cap={overCap.has(f.id)}
                  aria-current={f.id === current ? "true" : undefined}
                  title={`${SEVERITY_LABEL[f.severity]}: ${f.title}`}
                  onClick={() => nav.goToFinding(f.id)}
                >
                  <span className={styles.dot} aria-hidden />
                  <span className={styles.title}>{f.title}</span>
                  <span className={styles.line}>{lineOf(f)}</span>
                </button>
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}
