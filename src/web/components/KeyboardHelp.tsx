import { useEffect, useRef } from "react";
import { helpSet, selectHelpOpen } from "../store/focus.ts";
import { useAppDispatch, useAppSelector } from "../store/hooks.ts";
import styles from "./Dialog.module.css";

export const KEYS: readonly (readonly [string, string])[] = [
  ["j / k", "Next / previous file"],
  ["n / p", "Next / previous finding"],
  ["] / [", "Next / previous walkthrough stop"],
  ["x", "Collapse or expand the current file"],
  ["r", "Mark the current file viewed (or not)"],
  ["t", "Back to the summary (Back returns here)"],
  ["?", "Show this list"],
];

export function KeyboardHelp() {
  const open = useAppSelector(selectHelpOpen);
  const dispatch = useAppDispatch();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="keyboard-help-title"
      onClose={() => dispatch(helpSet(false))}
      onClick={(e) => {
        if (e.target === e.currentTarget) dialogRef.current?.close();
      }}
    >
      <header className={styles.header}>
        <h2 id="keyboard-help-title" className={styles.title}>
          Keyboard shortcuts
        </h2>
      </header>
      <dl className={styles.keys}>
        {KEYS.map(([keys, what]) => (
          <div key={keys} className={styles.key}>
            <dt>
              {keys.split(" / ").map((k, i) => (
                <span key={k}>
                  {i > 0 && " / "}
                  <kbd>{k}</kbd>
                </span>
              ))}
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.actions}>
        <button type="button" className={styles.button} onClick={() => dialogRef.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
