import { useEffect, useState } from "react";
import PhCheck from "~icons/ph/check";
import PhCopy from "~icons/ph/copy";
import { useRunNav } from "../lib/run-nav.ts";
import styles from "./CopyButton.module.css";

interface CopyButtonProps {
  text: () => string;
  label: string;
  title?: string;
}

export function CopyButton({ text, label, title }: CopyButtonProps) {
  const { copy } = useRunNav();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      className={styles.button}
      title={title ?? label}
      onClick={async (e) => {
        e.stopPropagation();
        if (await copy(text())) setCopied(true);
      }}
    >
      {copied ? <PhCheck aria-hidden /> : <PhCopy aria-hidden />}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}
