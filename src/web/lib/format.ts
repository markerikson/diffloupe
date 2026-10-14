import type { FindingSeverity, ReviewTarget } from "../../types/review-run.ts";

export const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  blocker: "Blocker",
  "should-fix": "Should fix",
  "nice-to-have": "Nice to have",
  question: "Question",
};

export function formatTarget(target: ReviewTarget): string {
  switch (target.kind) {
    case "pr":
      return `#${target.number} ${target.title}`;
    case "staged":
      return target.branch ? `Staged changes on ${target.branch}` : "Staged changes";
    case "worktree":
      return target.branch ? `Working tree on ${target.branch}` : "Working tree";
    default:
      return `${target.kind[0]!.toUpperCase()}${target.kind.slice(1)} ${target.spec}`;
  }
}

export function formatCost(usd: number): string {
  return usd === 0 ? "$0" : usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFormat.format(d);
}

export function formatRelative(iso: string, now = Date.now()): string {
  const diff = (now - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(diff)) return iso;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return formatDate(iso);
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function shortSha(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 12) : ref;
}
