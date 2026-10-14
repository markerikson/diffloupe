import { useEffect, useMemo, useRef } from "react";
import { keepInView } from "../lib/navigate.ts";
import PhFolderSimpleDuotone from "~icons/ph/folder-simple-duotone";
import PhSignpost from "~icons/ph/signpost";
import type { RunFile } from "../../types/review-run.ts";
import type { RunAnnotation } from "../lib/annotations.ts";
import { type FileNote, fileNotes } from "../lib/file-notes.ts";
import { fileRows } from "../lib/file-rows.ts";
import { useRunNav } from "../lib/run-nav.ts";
import { selectFocusedFinding, selectFocusedStop, selectStopLocation } from "../store/focus.ts";
import { useAppSelector } from "../store/hooks.ts";
import { selectFileTreeLayout } from "../store/view.ts";
import { DiffStats } from "./DiffStats.tsx";
import { FileStatus } from "./FileStatus.tsx";
import styles from "./FileTree.module.css";

interface FileTreeProps {
  files: readonly RunFile[];
  activePath: string | undefined;
  /** Findings and stop locations per file path, in diff order. */
  annotations: ReadonlyMap<string, RunAnnotation[]>;
  onSelect: (path: string) => void;
}

export function FileTree({ files, activePath, annotations, onSelect }: FileTreeProps) {
  const layout = useAppSelector(selectFileTreeLayout);
  const nav = useRunNav();
  const rows = useMemo(() => fileRows(files, [], layout), [files, layout]);
  const notes = useMemo(() => {
    const map = new Map<string, FileNote[]>();
    for (const f of files) {
      const list = annotations.get(f.path);
      if (list?.length) map.set(f.path, fileNotes(list, nav.stops));
    }
    return map;
  }, [annotations, files, nav.stops]);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (list && row) keepInView(list, row);
  }, [activePath]);

  return (
    <ul ref={listRef} className={styles.tree} data-layout={layout}>
      {rows.map((row) => {
        const rowNotes = row.file && notes.get(row.file.path);
        return (
          <li key={row.key}>
            <div
              className={styles.row}
              data-active={row.file?.path === activePath}
              style={{ paddingLeft: `${0.5 + row.depth}em` }}
            >
              {row.type === "folder" ? (
                <span className={styles.folder}>
                  <PhFolderSimpleDuotone aria-hidden />
                  <span className={styles.name}>{row.name}</span>
                </span>
              ) : row.file ? (
                <button type="button" className={styles.file} onClick={() => onSelect(row.file!.path)} title={row.file.path}>
                  <span className={styles.name}>{row.name}</span>
                  <DiffStats additions={row.file.additions} deletions={row.file.deletions} binary={row.file.isBinary} />
                  <FileStatus status={row.file.status} />
                </button>
              ) : (
                <span className={styles.missing}>{row.name}</span>
              )}
            </div>
            {rowNotes && <NoteList notes={rowNotes} depth={row.depth} file={row.name} />}
          </li>
        );
      })}
    </ul>
  );
}

function NoteList({ notes, depth, file }: { notes: readonly FileNote[]; depth: number; file: string }) {
  const nav = useRunNav();
  const focusedFinding = useAppSelector(selectFocusedFinding);
  const focusedStop = useAppSelector(selectFocusedStop);
  const stopLocation = useAppSelector(selectStopLocation);

  return (
    <ul className={styles.notes} style={{ marginLeft: `${0.5 + depth + 0.45}em` }} aria-label={`Notes on ${file}`}>
      {notes.map((note) => {
        const current =
          note.kind === "finding"
            ? note.id === focusedFinding
            : note.id === focusedStop && note.location === stopLocation;
        return (
          <li key={note.key}>
            <button
              type="button"
              className={styles.note}
              data-kind={note.kind}
              data-severity={note.kind === "finding" ? note.severity : undefined}
              data-importance={note.kind === "stop" ? note.importance : undefined}
              data-over-cap={note.kind === "finding" && note.overCap ? "true" : undefined}
              aria-current={current ? "true" : undefined}
              aria-label={note.label}
              title={note.tooltip}
              onClick={() =>
                note.kind === "finding" ? nav.goToFinding(note.id) : nav.goToStop(note.id, note.location)
              }
            >
              {note.kind === "finding" ? (
                <span className={styles.dot} aria-hidden />
              ) : (
                <PhSignpost className={styles.signpost} aria-hidden />
              )}
              <span className={styles.noteTitle}>{note.title}</span>
              {note.kind === "stop" && note.number > 0 && (
                <span className={styles.stopNumber} aria-hidden>
                  ({note.number})
                </span>
              )}
              <span className={styles.line} data-side={note.side}>
                {note.line}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
