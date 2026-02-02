/**
 * IntentInput - Textarea for stated intent with localStorage persistence
 */

import { useEffect, useCallback, useRef } from "react";
import styles from "./IntentInput.module.css";

const STORAGE_KEY = "diffloupe:stated-intent-draft";
const MAX_CHARS = 2000;

export interface IntentInputProps {
  value: string;
  onChange: (intent: string) => void;
  disabled?: boolean;
}

export function IntentInput({ value, onChange, disabled = false }: IntentInputProps) {
  const isInitialized = useRef(false);

  // Load from localStorage on mount
  useEffect(() => {
    if (isInitialized.current) return;
    isInitialized.current = true;

    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && !value) {
      onChange(saved);
    }
  }, [onChange, value]);

  // Save to localStorage on change (debounced via useEffect)
  useEffect(() => {
    if (!isInitialized.current) return;
    
    const timeoutId = setTimeout(() => {
      if (value) {
        localStorage.setItem(STORAGE_KEY, value);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [value]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value.slice(0, MAX_CHARS);
      onChange(newValue);
    },
    [onChange]
  );

  const handleClear = useCallback(() => {
    onChange("");
    localStorage.removeItem(STORAGE_KEY);
  }, [onChange]);

  const charCount = value.length;
  const isNearLimit = charCount > MAX_CHARS * 0.9;

  return (
    <div className={styles.container}>
      <div className={styles.labelRow}>
        <label className={styles.label} htmlFor="intent-input">
          Stated Intent
          <span className={styles.optional}>(optional)</span>
        </label>
        {value && (
          <button
            type="button"
            className={styles.clearButton}
            onClick={handleClear}
            disabled={disabled}
          >
            Clear
          </button>
        )}
      </div>
      <textarea
        id="intent-input"
        className={styles.textarea}
        value={value}
        onChange={handleChange}
        disabled={disabled}
        placeholder="Describe what this change is meant to accomplish. This helps the analysis detect if the actual changes align with your stated intent."
        rows={4}
      />
      <div className={styles.footer}>
        <p className={styles.hint}>
          Helps detect alignment between stated goals and actual changes
        </p>
        <span className={`${styles.charCount} ${isNearLimit ? styles.charCountWarning : ""}`}>
          {charCount}/{MAX_CHARS}
        </span>
      </div>
    </div>
  );
}
