import { useEffect, useMemo, useRef } from "react";
import { keepInView } from "../lib/navigate.ts";
import PhFolderSimpleDuotone from "~icons/ph/folder-simple-duotone";
import type { RunFile } from "../../types/review-run.ts";
import { fileRows } from "../lib/file-rows.ts";
import { useAppSelector } from "../store/hooks.ts";
import { selectFileTreeLayout } from "../store/view.ts";
import { DiffStats } from "./DiffStats.tsx";
import { FileStatus } from "./FileStatus.tsx";
import styles from "./FileTree.module.css";

interface FileTreeProps {
  files: readonly RunFile[];
  activePath: string | undefined;
  onSelect: (path: string) => void;
}

export function FileTree({ files, activePath, onSelect }: FileTreeProps) {
  const layout = useAppSelector(selectFileTreeLayout);
  const rows = useMemo(() => fileRows(files, [], layout), [files, layout]);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (list && row) keepInView(list, row);
  }, [activePath]);

  return (
    <ul ref={listRef} className={styles.tree} data-layout={layout}>
      {rows.map((row) => (
        <li
          key={row.key}
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
              <DiffStats additions={row.file.additions} deletions={row.file.deletions} />
              <FileStatus status={row.file.status} />
            </button>
          ) : (
            <span className={styles.missing}>{row.name}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
