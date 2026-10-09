import { describe, expect, test } from "bun:test";
import { formatEvent } from "./format-event.ts";

describe("formatEvent done line", () => {
  const base = { type: "done", status: "complete", costUsd: 1.234, wallMs: 61_400 } as const;

  test("counts all findings when none were carried over", () => {
    expect(formatEvent({ ...base, findings: 3, carriedOver: 0 })).toBe("3 finding(s) · $1.23 · 61s");
    expect(formatEvent({ ...base, findings: 3 })).toBe("3 finding(s) · $1.23 · 61s");
  });

  test("splits new and carried-over findings", () => {
    expect(formatEvent({ ...base, findings: 4, carriedOver: 3 })).toBe(
      "1 new finding(s), 3 carried over · $1.23 · 61s",
    );
  });

  test("reports a target with no code changes", () => {
    expect(formatEvent({ ...base, findings: 0, noChanges: true })).toBe("No code changes to review.");
  });
});
