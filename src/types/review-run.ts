/**
 * The saved form of one review: what the CLI, the server and the UI read.
 * Built from the review core's output by `src/review/build-run.ts`, but has no
 * imports from the core so the web bundle can use it.
 */

export type RunStatus = "running" | "complete" | "failed" | "cancelled";

export type ReviewTarget =
  | {
      kind: "pr";
      number: number;
      url: string;
      title: string;
      author: string;
      baseRef: string;
      headRef: string;
      state: string;
      isDraft: boolean;
    }
  | { kind: "range" | "branch" | "commit"; spec: string }
  | { kind: "staged" | "worktree"; branch?: string };

export type DiffSide = "additions" | "deletions";

export type AnchorReason = "not-in-diff" | "far-from-diff" | "no-line" | "deleted-file" | "no-hunks";

/**
 * Where a finding or walkthrough stop lands in the diff.
 *
 * - `line`: the cited line is visible in a hunk.
 * - `nearby`: the cited line is outside every hunk but close to one; `line` is
 *   the nearest visible line and `cited` keeps what the model wrote.
 * - `file`: no usable line; `line` is 0 and `reason` says why.
 */
export interface DiffAnchor {
  file: string;
  side: DiffSide;
  kind: "line" | "nearby" | "file";
  line: number;
  endLine?: number;
  cited: { line: number; endLine?: number };
  /** The patch text of `line`, without its newline. Set for `line` and `nearby`. */
  text?: string;
  reason?: AnchorReason;
}

export type RunFileStatus = "added" | "removed" | "modified" | "renamed" | "copied";

export interface RunFile {
  path: string;
  previousPath?: string;
  status: RunFileStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
  /** Blob id on the head side; all zeros for a removed file. */
  blob?: string;
  groupId: string;
  classification: "code" | "docs" | "skip";
}

export type GroupIcon = "bug" | "wrench" | "path" | "flask" | "doc" | "gear";

export interface RunGroup {
  id: string;
  /** Set on leaf groups that sit under a walkthrough chapter or a trailing section. */
  parentId?: string;
  title: string;
  summary?: string;
  icon?: GroupIcon;
  /** Files directly in this group. Parent groups list none of their own. */
  files: string[];
  findingIds: string[];
  stopIds: string[];
  critical: boolean;
}

export interface GuideStop {
  /** `c<chapter>-s<stop>`, both 1-based. */
  id: string;
  chapterId: string;
  index: number;
  title: string;
  prose?: string;
  importance: "critical" | "normal" | "context";
  locations: (DiffAnchor & { label?: string })[];
}

export type FindingSeverity = "blocker" | "should-fix" | "nice-to-have" | "question";

export interface RunFinding {
  /** Fingerprint of file and title, the same id the GitHub markers use. */
  id: string;
  file: string;
  anchor: DiffAnchor;
  severity: FindingSeverity;
  category: string;
  title: string;
  explanation: string;
  evidence: string;
  impact?: string;
  confidence: "high" | "medium" | "low";
  effort?: "quick" | "moderate" | "involved";
  suggestion?: string;
  suggestedCode?: string;
  crossFileRefs?: { file: string; line?: number }[];
  /** Id of a human's earlier comment making the same claim. */
  repeatOf?: number;
}

export interface RunSlice {
  unit: string;
  part: number;
  parts: number;
  status: "ok" | "failed";
  costUsd: number;
  wallMs: number;
}

export interface ReviewRun {
  schemaVersion: 1;
  id: string;
  status: RunStatus;
  createdAt: string;
  repo: { root: string; slug?: string };
  target: ReviewTarget;
  base: string;
  head: string;
  intent: {
    stated?: string;
    inferred?: string;
    alignment?: "aligned" | "partial" | "misaligned";
    matches?: string[];
    mismatches?: string[];
    unstated?: string[];
    missing?: string[];
  };
  overview: {
    focus?: string;
    changeType?: string;
    startHere: { file: string; why: string }[];
  };
  files: RunFile[];
  /** Parents come before their children; display order is array order. */
  groups: RunGroup[];
  stops: GuideStop[];
  findings: RunFinding[];
  /** Findings the review stands behind but cut by the posting cap. */
  overCapFindings: RunFinding[];
  resolved: { id: string; note?: string }[];
  unreviewed: { overCap: string[]; failed: string[] };
  meta: {
    model?: string;
    effort?: string;
    wallMs: number;
    costUsd: number;
    slices: RunSlice[];
    rejectedCount: number;
    coreSource: string;
    mergeMode?: "coordinator" | "nothing-to-merge" | "deterministic-fallback";
  };
  /** Untracked files left out of a working-tree snapshot because of their size. */
  untrackedSkipped: string[];
  priorRunId?: string;
  error?: string;
}

/** Reviewer state kept beside a run. Phase 2 only creates it empty. */
export interface RunUserState {
  reviewedFiles: string[];
  findingStatus: Record<string, "open" | "accepted" | "dismissed">;
  comments: {
    id: string;
    file: string;
    side: DiffSide;
    line: number;
    endLine?: number;
    body: string;
  }[];
  submitted?: { at: string; url?: string };
}

/** The fields `listRuns` reads from each `run.json`. */
export interface RunHeader {
  id: string;
  status: RunStatus;
  createdAt: string;
  target: ReviewTarget;
  repo: { root: string; slug?: string };
  findingCounts: Record<FindingSeverity, number>;
  costUsd: number;
}
