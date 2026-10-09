import { describe, expect, test } from "bun:test";
import { loadRun } from "../review/run-store.ts";
import { TargetError } from "../review/targets.ts";
import { bindDriver, readEvents, RunBusyError, RunManager } from "./run-manager.ts";
import { FakeDriver, useTempDataDir } from "./test-helpers.ts";

useTempDataDir();

function setup() {
  const driver = new FakeDriver();
  const runs = new RunManager(bindDriver(driver));
  return { driver, runs };
}

describe("RunManager", () => {
  test("allows one active run at a time", async () => {
    const { driver, runs } = setup();
    const { id, done } = await runs.start({});
    expect(runs.activeRunId).toBe(id);
    await expect(runs.start({})).rejects.toBeInstanceOf(RunBusyError);

    driver.finish({ ...runs.pendingRun(id)!, status: "complete" });
    await done;
    expect(runs.activeRunId).toBeNull();
    const second = await runs.start({});
    expect(second.id).not.toBe(id);
    driver.finish({ ...runs.pendingRun(second.id)!, status: "complete" });
    await second.done;
  });

  test("numbers events in order in events.jsonl and for subscribers", async () => {
    const { driver, runs } = setup();
    const { id, done } = await runs.start({});
    const seen: number[] = [];
    const sub = runs.subscribe(id, (e) => seen.push(e.seq));
    expect(sub).toBeDefined();
    driver.emit({ type: "stage", stage: "building_map" });
    driver.emit({ type: "log", message: "hello" });
    driver.finish({ ...runs.pendingRun(id)!, status: "complete" });
    const outcome = await done;
    expect(outcome.status).toBe("complete");

    const events = await readEvents(id);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.map((e) => e.type)).toEqual(["stage", "log", "done"]);
    expect(seen).toEqual([1, 2, 3]);
  });

  test("writes the pending run at start and replaces it at the end", async () => {
    const { driver, runs } = setup();
    const { id, done } = await runs.start({});
    expect((await loadRun(id))?.status).toBe("running");
    driver.finish({ ...runs.pendingRun(id)!, status: "complete" });
    await done;
    expect((await loadRun(id))?.status).toBe("complete");
  });

  test("cancel aborts the run and emits cancelled", async () => {
    const { runs } = setup();
    const { id } = await runs.start({});
    const outcome = await runs.cancel(id);
    expect(outcome).toEqual({ status: "cancelled" });
    expect((await readEvents(id)).at(-1)?.type).toBe("cancelled");
    expect(runs.activeRunId).toBeNull();
    expect(runs.cancel(id)).toBeUndefined();
  });

  test("a failing run emits error with the message", async () => {
    const { driver, runs } = setup();
    const { id, done } = await runs.start({});
    driver.fail("model exploded");
    expect(await done).toEqual({ status: "failed", error: "model exploded" });
    const last = (await readEvents(id)).at(-1);
    expect(last).toMatchObject({ type: "error", message: "model exploded" });
  });

  test("a prepare error rejects start and leaves no active run", async () => {
    const { driver, runs } = setup();
    driver.prepareError = new TargetError("no changes to review");
    await expect(runs.start({})).rejects.toBeInstanceOf(TargetError);
    expect(runs.activeRunId).toBeNull();
  });

  test("watchers see every run's events", async () => {
    const { driver, runs } = setup();
    const seen: string[] = [];
    runs.watch((runId, e) => seen.push(`${runId}:${e.type}`));
    const { id, done } = await runs.start({});
    driver.emit({ type: "stage", stage: "reviewing" });
    driver.finish({ ...runs.pendingRun(id)!, status: "complete" });
    await done;
    expect(seen).toEqual([`${id}:stage`, `${id}:done`]);
  });
});
