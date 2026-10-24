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
    case "groups": {
      const n = e.groups.filter((g) => g.files.length).length;
      return `  ${e.files.length} file(s) in ${n} group(s)`;
    }
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
    case "done": {
      if (e.kind === "diff") {
        const cost = e.costUsd ? ` · $${e.costUsd.toFixed(2)}` : "";
        return `${e.files ?? 0} file(s) changed${cost} · ${(e.wallMs / 1000).toFixed(1)}s`;
      }
      if (e.roundLimit) return `Not reviewed: this change already had ${e.roundLimit} round(s) of review (--max-rounds).`;
      if (e.noChanges) return "No code changes to review.";
      const carried = e.carriedOver ?? 0;
      const found = carried
        ? `${e.findings - carried} new finding(s), ${carried} carried over`
        : `${e.findings} finding(s)`;
      return `${found} · $${e.costUsd.toFixed(2)} · ${Math.round(e.wallMs / 1000)}s`;
    }
    case "cancelled":
      return "Run cancelled.";
    case "error":
      return `Run failed: ${e.message}`;
  }
}
