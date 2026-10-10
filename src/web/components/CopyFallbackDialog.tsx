import { useEffect, useRef } from "react";
import styles from "./Dialog.module.css";

interface CopyFallbackDialogProps {
  text: string;
  onClose: () => void;
}

/** Shown when the clipboard API is unavailable: the text is selected so Ctrl+C copies it. */
export function CopyFallbackDialog({ text, onClose }: CopyFallbackDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
    textRef.current?.select();
  }, []);

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="copy-fallback-title" onClose={onClose}>
      <header className={styles.header}>
        <h2 id="copy-fallback-title" className={styles.title}>
          Copy this text
        </h2>
      </header>
      <p className={styles.hint}>The browser blocked clipboard access. The text is selected; press Ctrl+C or ⌘C.</p>
      <textarea ref={textRef} className={styles.text} readOnly value={text} rows={16} />
      <div className={styles.actions}>
        <button type="button" className={styles.button} onClick={() => dialogRef.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
