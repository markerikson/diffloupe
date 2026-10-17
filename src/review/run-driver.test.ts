import { describe, expect, test } from "bun:test";
import { loadFixture } from "./__fixtures__/load.ts";
import { requestFromOptions, roundOf } from "./run-driver.ts";
import type { ReviewRun } from "../types/review-run.ts";

const base = loadFixture("small-commit").build();

function store(runs: Record<string, Partial<ReviewRun>>) {
  return async (id: string): Promise<ReviewRun> => {
    const over = runs[id];
    if (!over) throw new Error(`no run ${id}`);
    return { ...base, id, ...over };
  };
}

describe("roundOf", () => {
  test("uses the recorded round", async () => {
    expect(await roundOf({ round: 3 }, store({}))).toBe(3);
  });

  test("a run with no prior is round 1", async () => {
    expect(await roundOf({}, store({}))).toBe(1);
  });

  test("older runs count the chain back to a recorded round", async () => {
    const load = store({ b: { priorRunId: "a" }, a: { round: 2 } });
    expect(await roundOf({ priorRunId: "b" }, load)).toBe(4);
  });

  test("a missing prior ends the chain", async () => {
    expect(await roundOf({ priorRunId: "gone" }, store({}))).toBe(1);
  });

  test("a cycle in the chain stops", async () => {
    const load = store({ a: { priorRunId: "b" }, b: { priorRunId: "a" } });
    expect(await roundOf({ priorRunId: "a" }, load)).toBe(3);
  });
});

describe("requestFromOptions", () => {
  test("passes --full through only when set", async () => {
    expect((await requestFromOptions({ full: true })).full).toBe(true);
    expect("full" in (await requestFromOptions({}))).toBe(false);
  });
});
