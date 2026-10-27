import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configureStore } from "@reduxjs/toolkit";
import type { RunEvent, StoredEvent } from "../../server/types.ts";
import type { ReviewRun } from "../../types/review-run.ts";
import { api } from "./api.ts";

// Bun has no browser EventSource. Substitute only its transport boundary; the
// event validation, subscription lifecycle, API queries and Redux cache are real.
class TestEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: TestEventSource[] = [];
  readyState = TestEventSource.OPEN;
  private seq = 0;

  constructor(readonly url: string) {
    super();
    TestEventSource.instances.push(this);
  }

  emit(event: RunEvent, seq = this.seq + 1): StoredEvent {
    this.seq = Math.max(this.seq, seq);
    const stored = { ...event, seq, at: "2026-10-26T00:00:00.000Z" };
    this.dispatchEvent(new MessageEvent(event.type, {
      data: JSON.stringify(stored), lastEventId: String(seq),
    }));
    return stored;
  }

  close() {
    this.readyState = TestEventSource.CLOSED;
  }
}

function makeStore() {
  return configureStore({
    reducer: { [api.reducerPath]: api.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(api.middleware),
  });
}

function runningRun(): ReviewRun {
  return {
    schemaVersion: 1,
    id: "test-run",
    status: "running",
    createdAt: "2026-10-26T00:00:00.000Z",
    repo: { root: "/repo" },
    target: { kind: "pr", number: 42, url: "https://github.com/example/repo/pull/42", title: "Example PR", author: "author", baseRef: "main", headRef: "feature", state: "OPEN", isDraft: false },
    base: "base",
    head: "head",
    intent: {},
    overview: { startHere: [] },
    files: [{ path: "src/main.ts", status: "modified", additions: 2, deletions: 1, isBinary: false, groupId: "pending", classification: "code" }],
    groups: [],
    stops: [],
    findings: [],
    overCapFindings: [],
    resolved: [],
    unreviewed: { overCap: [], failed: [] },
    meta: { wallMs: 0, costUsd: 0, slices: [], rejectedCount: 0, coreSource: "test" },
    untrackedSkipped: [],
  };
}

const NativeRequest = globalThis.Request;
const eventSourceDescriptor = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
let run: ReviewRun;
let patch: string;
let server: ReturnType<typeof Bun.serve>;
let stores: ReturnType<typeof makeStore>[];
let requests: Map<string, number>;

beforeEach(() => {
  run = runningRun();
  patch = "pending patch";
  stores = [];
  requests = new Map();
  TestEventSource.instances = [];
  Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: TestEventSource });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
      if (pathname === `/api/runs/${run.id}`) return Response.json(run);
      if (pathname === `/api/runs/${run.id}/diff`) return new Response(patch);
      if (pathname === "/api/runs") return Response.json([{
        id: run.id, status: run.status, createdAt: run.createdAt,
        target: run.target, repo: run.repo, costUsd: run.meta.costUsd,
        findingCounts: { blocker: 0, "should-fix": 0, "nice-to-have": 0, question: 0 },
      }]);
      return new Response("Not found", { status: 404 });
    },
  });
  // Match browser relative-URL resolution while retaining real local HTTP.
  globalThis.Request = class extends NativeRequest {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, server.url) : input, init);
    }
  };
});

afterEach(async () => {
  for (const store of stores) store.dispatch(api.util.resetApiState());
  await Promise.resolve();
  await server.stop(true);
  globalThis.Request = NativeRequest;
  if (eventSourceDescriptor) Object.defineProperty(globalThis, "EventSource", eventSourceDescriptor);
  else Reflect.deleteProperty(globalThis, "EventSource");
});

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2000;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (check() || Date.now() >= deadline) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
  expect(check()).toBe(true);
}

async function openRun() {
  const store = makeStore();
  stores.push(store);
  const query = store.dispatch(api.endpoints.getRun.initiate(run.id));
  await query.unwrap();
  const source = TestEventSource.instances.at(-1);
  if (!source) throw new Error("The running run did not open an event stream");
  const current = () => api.endpoints.getRun.select(run.id)(store.getState()).data!;
  return { store, source, query, current };
}

describe("live run progress", () => {
  test("receives groups before completion and clears detail when the stage changes", async () => {
    const { source, current } = await openRun();
    expect(source.url).toBe("/api/runs/test-run/events");
    source.emit({ type: "stage", stage: "grouping" });
    source.emit({ type: "log", message: "Naming the review groups" });
    expect(current().progress?.lastMessage).toBe("Naming the review groups");

    const group = { id: "core", title: "Core changes", files: ["src/main.ts"], findingIds: [], stopIds: [], critical: false };
    source.emit({ type: "groups", groups: [group], files: [{ path: "src/main.ts", groupId: "core", classification: "code" }] });
    expect(current().groups).toEqual([group]);
    expect(current().files[0]?.groupId).toBe("core");
    expect(current().status).toBe("running");

    source.emit({ type: "stage", stage: "building_map" });
    expect(current().progress?.stage).toBe("building_map");
    expect(current().progress?.lastMessage).toBeUndefined();
    source.emit({ type: "stage", stage: "grouping" });
    source.emit({ type: "log", message: "Refining group names" });
    expect(current().progress?.stage).toBe("grouping");
    expect(current().progress?.lastMessage).toBe("Refining group names");
  });

  test("tracks slices with the same title independently, including failures", async () => {
    const { source, current } = await openRun();
    source.emit({ type: "stage", stage: "reviewing" });
    source.emit({ type: "slice", index: 1, total: 3, title: "Shared title", status: "started" });
    source.emit({ type: "slice", index: 0, total: 3, title: "Shared title", status: "started" });
    source.emit({ type: "slice", index: 1, total: 3, title: "Shared title", status: "ok", costUsd: 0.1 });
    expect(current().progress).toMatchObject({ slicesTotal: 3, slicesDone: 1, slicesFailed: 0, activeSlices: ["Shared title"] });
    source.emit({ type: "slice", index: 0, total: 3, title: "Shared title", status: "failed" });
    source.emit({ type: "budget", totalUsd: 0.25, limitUsd: 0.2, skippedSlices: 1 });
    expect(current().progress).toMatchObject({ slicesTotal: 3, slicesDone: 1, slicesFailed: 1, activeSlices: [], lastMessage: "Budget reached: $0.25 of $0.20" });
  });

  test("retains progress while reconnecting and ignores repeated event sequences", async () => {
    const { source, current } = await openRun();
    source.emit({ type: "stage", stage: "reviewing" }, 1);
    source.emit({ type: "slice", index: 0, total: 2, title: "First", status: "started" }, 2);
    source.emit({ type: "slice", index: 0, total: 2, title: "First", status: "ok" }, 3);
    source.readyState = TestEventSource.CONNECTING;
    source.dispatchEvent(new Event("error"));
    expect(source.readyState).toBe(TestEventSource.CONNECTING);
    expect(requests.get(`/api/runs/${run.id}`)).toBe(1);
    source.readyState = TestEventSource.OPEN;
    source.emit({ type: "stage", stage: "grouping" }, 1);
    source.emit({ type: "slice", index: 0, total: 2, title: "First", status: "started" }, 2);
    source.emit({ type: "slice", index: 0, total: 2, title: "First", status: "ok" }, 3);
    source.emit({ type: "slice", index: 1, total: 2, title: "Second", status: "started" }, 4);
    expect(current().progress).toMatchObject({ stage: "reviewing", slicesDone: 1, slicesFailed: 0, activeSlices: ["Second"] });
  });

  test("rebuilds progress from replay after reopening and preserves it on HTTP refetch", async () => {
    const first = await openRun();
    const history = [
      first.source.emit({ type: "stage", stage: "reviewing" }),
      first.source.emit({ type: "slice", index: 0, total: 2, title: "First", status: "ok" }),
      first.source.emit({ type: "slice", index: 1, total: 2, title: "Second", status: "started" }),
      first.source.emit({ type: "cost", totalUsd: 0.4 }),
      first.source.emit({ type: "log", message: "Reviewing the remaining files" }),
    ];
    const beforeReload = first.current().progress;
    first.store.dispatch(api.util.resetApiState());
    await Promise.resolve();
    expect(first.source.readyState).toBe(TestEventSource.CLOSED);

    const reopened = await openRun();
    for (const event of history) reopened.source.emit(event, event.seq);
    expect(reopened.current().progress).toEqual(beforeReload);
    run = { ...run, intent: { stated: "Refreshed server data" } };
    await reopened.query.refetch().unwrap();
    expect(reopened.current().intent.stated).toBe("Refreshed server data");
    expect(reopened.current().progress).toEqual(beforeReload);
    reopened.source.emit({ type: "slice", index: 1, total: 2, title: "Second", status: "ok" });
    expect(reopened.current().progress).toMatchObject({ stage: "reviewing", slicesDone: 2, activeSlices: [], costUsd: 0.4 });
  });

  test("completion closes the stream and refreshes the final run, patch and list once", async () => {
    const { store, source, current } = await openRun();
    await store.dispatch(api.endpoints.listRuns.initiate()).unwrap();
    await store.dispatch(api.endpoints.getRunPatch.initiate(run.id)).unwrap();
    source.emit({ type: "stage", stage: "writing" });
    run = { ...run, status: "complete", meta: { ...run.meta, costUsd: 0.7 } };
    patch = "final patch";
    source.emit({ type: "done", status: "complete", findings: 0, costUsd: 0.7, wallMs: 100 });
    source.dispatchEvent(new MessageEvent("end", { data: "{}" }));
    source.emit({ type: "stage", stage: "grouping" });
    await waitFor(() => current().status === "complete"
      && api.endpoints.listRuns.select()(store.getState()).data?.[0]?.status === "complete"
      && api.endpoints.getRunPatch.select(run.id)(store.getState()).data === "final patch");
    expect(current().progress).toBeUndefined();
    expect(current().meta.costUsd).toBe(0.7);
    expect(source.readyState).toBe(TestEventSource.CLOSED);
    expect(requests.get(`/api/runs/${run.id}`)).toBe(2);
    expect(requests.get(`/api/runs/${run.id}/diff`)).toBe(2);
    expect(requests.get("/api/runs")).toBe(2);
  });

  test("a server error is terminal even though transport errors use the same event name", async () => {
    const { source, current } = await openRun();
    source.emit({ type: "stage", stage: "reviewing" });
    run = { ...run, status: "failed", error: "Review process stopped" };
    source.emit({ type: "error", message: "Review process stopped" });
    await waitFor(() => current().status === "failed");
    expect(current().error).toBe("Review process stopped");
    expect(current().progress).toBeUndefined();
    expect(source.readyState).toBe(TestEventSource.CLOSED);
  });

  test("cancellation refreshes the saved outcome", async () => {
    const { source, current } = await openRun();
    run = { ...run, status: "cancelled" };
    source.emit({ type: "cancelled" });
    await waitFor(() => current().status === "cancelled");
    expect(source.readyState).toBe(TestEventSource.CLOSED);
  });

  test("an end-only replay refreshes a run that stopped while the page was loading", async () => {
    const { source, current } = await openRun();
    run = { ...run, status: "failed", error: "Interrupted run" };
    source.dispatchEvent(new MessageEvent("end", { data: "{}" }));
    await waitFor(() => current().status === "failed");
    expect(source.readyState).toBe(TestEventSource.CLOSED);
  });
});
