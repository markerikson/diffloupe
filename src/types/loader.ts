import type { DiffFile } from "./diff.js";

/** Priority tier for diff file classification */
export type FileTier = 1 | 2 | 3;

/** A diff file with its classification metadata */
export interface ClassifiedFile {
  file: DiffFile;
  tier: FileTier;
  /** Why this file got assigned to this tier */
  reason: string;
  /** Estimated token count for this file */
  estimatedTokens: number;
}

/** Result of budget-based file selection */
export interface LoadBudgetResult {
  /** Files included within the token budget */
  included: ClassifiedFile[];
  /** Files excluded due to budget constraints */
  excluded: ClassifiedFile[];
  /** Total estimated tokens for included files */
  totalTokens: number;
}
