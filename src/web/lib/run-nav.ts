import { createContext, useContext } from "react";
import type { GuideStop } from "../../types/review-run.ts";

export interface GoToOptions {
  scroll?: boolean;
  /** The URL already names this target (Back/Forward or a pasted link), so leave history alone. */
  fromUrl?: boolean;
}

export interface RunNav {
  runId: string;
  /** Scrolls back to the summary and adds a history entry, so Back returns to where the reader was. */
  goToTop(): void;
  goToFile(path: string): void;
  /** Focuses a finding; `scroll: false` when its card is already on screen. */
  goToFinding(id: string, opts?: GoToOptions): void;
  goToStop(id: string, location?: number, opts?: GoToOptions): void;
  /** Copies text, or shows it in a dialog when the clipboard is unavailable. Resolves true when copied. */
  copy(text: string): Promise<boolean>;
  /** Walkthrough stops in guide order. */
  stops: readonly GuideStop[];
}

export const RunNavContext = createContext<RunNav | null>(null);

export function useRunNav(): RunNav {
  const nav = useContext(RunNavContext);
  if (!nav) throw new Error("useRunNav needs a RunNavContext provider");
  return nav;
}
