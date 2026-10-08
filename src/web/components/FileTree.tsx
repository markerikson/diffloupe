import type { DiffFile } from "../../types/diff.js";
import { getFileStats } from "../utils/diffStats.js";
import styles from "./FileTree.module.css";

export interface FileTreeProps {
  files: DiffFile[];
  onFileClick: (path: string) => void;
}

const STATUS_LABELS: Record<DiffFile["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
};

export function FileTree({ files, onFileClick }: FileTreeProps) {
  if (files.length === 0) return null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>Files</div>
      <ul className={styles.list}>
        {files.map((file) => {
          const stats = getFileStats(file);
          const lastSlash = file.path.lastIndexOf("/");
          const filename = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
          const directory = lastSlash >= 0 ? file.path.slice(0, lastSlash) : "";

          return (
            <li key={file.path} className={styles.item}>
              <button
                className={styles.button}
                onClick={() => onFileClick(file.path)}
                type="button"
              >
                <span className={styles.badge} data-status={file.status}>
                  {STATUS_LABELS[file.status]}
                </span>
                <span className={styles.nameBlock}>
                  <span className={styles.filename}>{filename}</span>
                  {directory && (
                    <span className={styles.directory}>{directory}</span>
                  )}
                </span>
                <span className={styles.stats}>
                  {stats.added > 0 && (
                    <span className={styles.added}>+{stats.added}</span>
                  )}
                  {stats.deleted > 0 && (
                    <span className={styles.deleted}>-{stats.deleted}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
