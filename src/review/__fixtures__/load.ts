import path from "node:path";
import { readFileSync } from "node:fs";
import { buildReviewRun, type BuildReviewRunInput } from "../build-run.ts";
import type { ReviewRun, ReviewTarget } from "../../types/review-run.ts";

export interface Fixture {
  name: string;
  patch: string;
  input: BuildReviewRunInput;
  logs: string[];
  build(): ReviewRun;
}

function json<T>(dir: string, file: string): T {
  return JSON.parse(readFileSync(path.join(dir, file), "utf8")) as T;
}

/**
 * Loads `__fixtures__/<name>/`: `diff.patch`, `units.json`, `byClass.json`,
 * `record.json` (`null` for a review with no code files) and optional
 * `meta.json` ({ target, untrackedSkipped }).
 */
export function loadFixture(name: string): Fixture {
  const dir = path.join(import.meta.dir, name);
  const patch = readFileSync(path.join(dir, "diff.patch"), "utf8");
  const record = json<Record<string, unknown> | null>(dir, "record.json");
  let meta: { target?: ReviewTarget; untrackedSkipped?: string[] } = {};
  try {
    meta = json(dir, "meta.json");
  } catch {
    // No overrides.
  }
  const logs: string[] = [];
  const input: BuildReviewRunInput = {
    id: `fixture-${name}`,
    createdAt: "2026-10-08T00:00:00.000Z",
    repo: { root: "/repo" },
    target: meta.target ?? { kind: "commit", spec: "HEAD" },
    base: String(record?.base ?? "base"),
    head: String(record?.head ?? "head"),
    patch,
    result: {
      record,
      units: json(dir, "units.json"),
      byClass: json(dir, "byClass.json"),
      costUsd: 0,
      wallMs: 0,
    },
    untrackedSkipped: meta.untrackedSkipped ?? [],
    coreSource: "diffloupe@test",
    log: (m) => logs.push(m),
  };
  return { name, patch, input, logs, build: () => buildReviewRun(input) };
}
