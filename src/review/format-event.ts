import type { RunEvent } from "../server/types.ts";

/** One terminal line for a run event, or null for events not worth a line. */
export function formatEvent(e: RunEvent): string | null {
  switch (e.type) {
    case "stage":
      return `» ${e.stage.replaceAll("_", " ")}`;
    case "log":
      return e.message;
    case "cost":
      return null;
    case "budget":
      return (
        `  cost limit reached: $${e.totalUsd.toFixed(2)} of $${e.limitUsd.toFixed(2)}, ` +
        `${e.skippedSlices} slice(s) not started`
      );
    case "slice": {
      const n = `[${e.index + 1}/${e.total}]`;
      if (e.status === "started") return `  ${n} ${e.title}`;
      const cost = e.costUsd !== undefined ? ` $${e.costUsd.toFixed(2)}` : "";
      const wall = e.wallMs !== undefined ? ` ${Math.round(e.wallMs / 1000)}s` : "";
      const found = e.findings !== undefined ? ` ${e.findings} finding(s)` : "";
      return `  ${n} ${e.status === "ok" ? "done" : "FAILED"}${cost}${wall}${found} — ${e.title}`;
    }
    case "done":
      return e.noChanges
        ? "No code changes to review."
        : `${e.findings} finding(s) · $${e.costUsd.toFixed(2)} · ${Math.round(e.wallMs / 1000)}s`;
    case "cancelled":
      return "Review cancelled.";
    case "error":
      return `Review failed: ${e.message}`;
  }
}
