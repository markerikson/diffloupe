import { useEffect, useRef, useState } from "react";
import PhArrowsInLineVertical from "~icons/ph/arrows-in-line-vertical";
import PhCaretDown from "~icons/ph/caret-down";
import styles from "./CollapseMenu.module.css";

export interface CollapseAction {
  label: string;
  run: () => void;
}

export function CollapseMenu({ actions }: { actions: readonly CollapseAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Expand or collapse files"
      >
        <PhArrowsInLineVertical aria-hidden />
        <PhCaretDown aria-hidden className={styles.small} />
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                a.run();
                setOpen(false);
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
