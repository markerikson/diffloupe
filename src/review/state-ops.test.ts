import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadFixture } from "./__fixtures__/load.ts";
import {
  createRunDir,
  InvalidStateError,
  loadState,
  runDir,
  setFileReviewed,
  setFindingStatus,
  updateState,
  writeRun,
  writeState,
} from "./run-store.ts";
import { applyStateOp, emptyState, parseState, StateOpError, type StateOp } from "./state-ops.ts";
import { type } from "arktype";
import { formatRun } from "./format-run.ts";

const run = loadFixture("large-pr").build();
const [first, second] = run.findings;
const overCap = run.overCapFindings[0];
const modified = run.files.find((f) => f.status !== "removed" && f.blob);
const at = "2026-10-21T00:00:00.000Z";

const finding = (ids: string[], status: "open" | "accepted" | "dismissed", extra: Partial<StateOp> = {}): StateOp =>
  ({ op: "finding", ids, status, at, ...extra }) as StateOp;

describe("applyStateOp", () => {
  test("fixture has what the tests need", () => {
    expect(first && second && overCap && modified).toBeTruthy();
  });

  test("dismiss records the reason and note; accept and reopen clear them", () => {
    let state = applyStateOp(
      emptyState(),
      finding([first!.id, overCap!.id], "dismissed", { reason: "wrong", note: "guarded" }),
      run,
    );
    expect(state.findingStatus).toEqual({ [first!.id]: "dismissed", [overCap!.id]: "dismissed" });
    expect(state.findingNotes?.[first!.id]).toEqual({ reason: "wrong", note: "guarded", at });

    state = applyStateOp(state, finding([first!.id], "accepted"), run);
    expect(state.findingStatus[first!.id]).toBe("accepted");
    expect(state.findingNotes?.[first!.id]).toBeUndefined();

    state = applyStateOp(state, finding([first!.id, overCap!.id], "open"), run);
    expect(state.findingStatus).toEqual({});
    expect("findingNotes" in state).toBe(false);
  });

  test("rejects unknown finding ids, empty id lists, and a dismissal with no reason", () => {
    expect(() => applyStateOp(emptyState(), finding(["nope", first!.id], "accepted"), run)).toThrow(
      new StateOpError("unknown findings: nope"),
    );
    expect(() => applyStateOp(emptyState(), finding([], "accepted"), run)).toThrow(StateOpError);
    expect(() => applyStateOp(emptyState(), finding([first!.id], "dismissed"), run)).toThrow(/needs a reason/);
  });

  test("reviewed files are keyed by path with the head blob id; removed files get ''", () => {
    const removed = { ...modified!, path: "gone.ts", status: "removed" as const, blob: "0000000" };
    const withRemoved = { ...run, files: [...run.files, removed] };
    let state = applyStateOp(
      emptyState(),
      { op: "reviewed", paths: [modified!.path, "gone.ts"], value: true },
      withRemoved,
    );
    expect(state.reviewedFiles).toEqual({ [modified!.path]: modified!.blob!, "gone.ts": "" });
    state = applyStateOp(state, { op: "reviewed", paths: ["gone.ts"], value: false }, withRemoved);
    expect(state.reviewedFiles).toEqual({ [modified!.path]: modified!.blob! });
    expect(() => applyStateOp(state, { op: "reviewed", paths: ["nope.ts"], value: true }, run)).toThrow(
      "unknown file: nope.ts",
    );
  });

  test("does not change the state it was given", () => {
    const before = emptyState();
    applyStateOp(before, finding([first!.id], "accepted"), run);
    applyStateOp(before, { op: "reviewed", paths: [modified!.path], value: true }, run);
    expect(before).toEqual(emptyState());
  });

  test("parseState reads the old empty reviewedFiles array and rejects bad values", () => {
    expect(parseState({ reviewedFiles: [], findingStatus: {}, comments: [] })).toEqual(emptyState());
    expect(parseState({ ...emptyState(), findingStatus: { a: "maybe" } })).toBeInstanceOf(type.errors);
    expect(
      parseState({ ...emptyState(), findingNotes: { a: { reason: "because", at } } }),
    ).toBeInstanceOf(type.errors);
  });
});

describe("state store", () => {
  let tmp: string;
  const saved = process.env.XDG_DATA_HOME;
  const id = "state-run";

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "diffloupe-state-"));
    process.env.XDG_DATA_HOME = tmp;
    await createRunDir(id);
    await writeRun({ ...run, id });
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
    await rm(tmp, { recursive: true, force: true });
  });

  test("setFindingStatus and setFileReviewed write state.json and leave no temp files", async () => {
    await setFindingStatus(id, [first!.id], "dismissed", { reason: "duplicate" });
    await setFileReviewed(id, modified!.path, true);
    const saved = JSON.parse(await readFile(path.join(runDir(id), "state.json"), "utf8"));
    expect(saved.findingStatus).toEqual({ [first!.id]: "dismissed" });
    expect(saved.findingNotes[first!.id].reason).toBe("duplicate");
    expect(saved.reviewedFiles).toEqual({ [modified!.path]: modified!.blob });
    expect((await readdir(runDir(id))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(await loadState(id)).toEqual(saved);
  });

  test("rejects unknown ids without writing", async () => {
    const before = await readFile(path.join(runDir(id), "state.json"), "utf8");
    await expect(setFindingStatus(id, ["nope"], "accepted")).rejects.toThrow(StateOpError);
    expect(await readFile(path.join(runDir(id), "state.json"), "utf8")).toBe(before);
  });

  test("concurrent changes to one run all land", async () => {
    await writeState(id, emptyState());
    await Promise.all([
      setFindingStatus(id, [first!.id], "accepted"),
      setFindingStatus(id, [second!.id], "dismissed", { reason: "wrong" }),
      setFileReviewed(id, modified!.path, true),
    ]);
    const state = await loadState(id);
    expect(state.findingStatus).toEqual({ [first!.id]: "accepted", [second!.id]: "dismissed" });
    expect(Object.keys(state.reviewedFiles)).toEqual([modified!.path]);
  });

  test("an invalid state.json is not overwritten; loadState reads it as empty", async () => {
    await writeFile(path.join(runDir(id), "state.json"), "{ not json");
    await expect(updateState(id, finding([first!.id], "accepted"))).rejects.toThrow(InvalidStateError);
    expect(await readFile(path.join(runDir(id), "state.json"), "utf8")).toBe("{ not json");
    expect(await loadState(id)).toEqual(emptyState());
    await writeState(id, emptyState());
  });

  test("runs show text marks triaged findings and counts reviewed files", async () => {
    await setFindingStatus(id, [first!.id], "dismissed", { reason: "not-worth-fixing" });
    await setFileReviewed(id, modified!.path, true);
    const text = formatRun({ ...run, id }, await loadState(id));
    expect(text).toContain(`${first!.title}  (dismissed: not-worth-fixing`);
    expect(text).toContain(`id ${first!.id}`);
    expect(text).toContain(`triage: 1 dismissed, 1 of ${run.files.length} files reviewed`);
  });
});
