/**
 * TargetSelector - Select diff target via dropdown or custom input
 */

import { useState, useCallback } from "react";
import styles from "./TargetSelector.module.css";

/** Common predefined targets */
const PRESET_TARGETS = [
  { value: "staged", label: "Staged changes" },
  { value: "unstaged", label: "Unstaged changes" },
  { value: "HEAD", label: "HEAD (all uncommitted)" },
] as const;

export interface TargetSelectorProps {
  value: string;
  onChange: (target: string) => void;
  disabled?: boolean;
}

export function TargetSelector({ value, onChange, disabled = false }: TargetSelectorProps) {
  // Track whether we're in "custom" mode
  const isPreset = PRESET_TARGETS.some((t) => t.value === value);
  const [mode, setMode] = useState<"preset" | "custom">(isPreset ? "preset" : "custom");
  const [customValue, setCustomValue] = useState(isPreset ? "" : value);

  const handlePresetChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newValue = e.target.value;
      if (newValue === "__custom__") {
        setMode("custom");
        // Keep current custom value or default to empty
        if (customValue) {
          onChange(customValue);
        }
      } else {
        setMode("preset");
        onChange(newValue);
      }
    },
    [onChange, customValue]
  );

  const handleCustomChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setCustomValue(newValue);
      onChange(newValue);
    },
    [onChange]
  );

  const handleBackToPreset = useCallback(() => {
    setMode("preset");
    onChange("staged");
  }, [onChange]);

  return (
    <div className={styles.container}>
      <label className={styles.label} htmlFor="target-selector">
        Diff Target
      </label>
      <div className={styles.inputGroup}>
        {mode === "preset" ? (
          <select
            id="target-selector"
            className={styles.select}
            value={value}
            onChange={handlePresetChange}
            disabled={disabled}
          >
            {PRESET_TARGETS.map((target) => (
              <option key={target.value} value={target.value}>
                {target.label}
              </option>
            ))}
            <option value="__custom__">Custom...</option>
          </select>
        ) : (
          <div className={styles.customInput}>
            <input
              id="target-selector"
              type="text"
              className={styles.input}
              value={customValue}
              onChange={handleCustomChange}
              placeholder="commit:abc123, branch:main, range:a..b"
              disabled={disabled}
              autoFocus
            />
            <button
              type="button"
              className={styles.backButton}
              onClick={handleBackToPreset}
              disabled={disabled}
              title="Back to presets"
            >
              <span className={styles.backIcon}>×</span>
            </button>
          </div>
        )}
      </div>
      <p className={styles.hint}>
        {mode === "preset"
          ? "Select a common target or choose Custom for specific commits/branches"
          : "Format: commit:hash, branch:name, or range:a..b"}
      </p>
    </div>
  );
}
