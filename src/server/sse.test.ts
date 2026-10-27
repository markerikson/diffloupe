import { describe, expect, spyOn, test } from "bun:test";
import { SSEStreamingApi } from "hono/streaming";
import { createApp } from "./index.ts";
import { FakeDriver, fakeContext, useTempDataDir } from "./test-helpers.ts";

useTempDataDir();

interface Message {
  id?: string;
  event: string;
  data: string;
}

async function readAll(res: Response): Promise<Message[]> {
  const text = await res.text();
  const out: Message[] = [];
  for (const block of text.split("\n\n")) {
    const msg: Message = { event: "message", data: "" };
    let any = false;
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const [field, ...rest] = line.split(":");
      const value = rest.join(":").replace(/^ /, "");
      any = true;
      if (field === "id") msg.id = value;
      else if (field === "event") msg.event = value;
      else if (field === "data") msg.data = value;
    }
    if (any) out.push(msg);
  }
  return out;
}

function setup() {
  const driver = new FakeDriver();
  const ctx = fakeContext(driver);
  return { driver, ctx, app: createApp(ctx) };
}

describe("GET /api/runs/:id/events", () => {
  test("replays a finished run and ends", async () => {
    const { driver, ctx, app } = setup();
    const { id, done } = await ctx.runs.start({});
    driver.emit({ type: "stage", stage: "building_map" });
    driver.emit({ type: "log", message: "one" });
    driver.finish({ ...ctx.runs.pendingRun(id)!, status: "complete" });
    await done;

    const res = await app.request(`/api/runs/${id}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const msgs = await readAll(res);
    expect(msgs.map((m) => m.event)).toEqual(["stage", "log", "done", "end"]);
    expect(msgs.slice(0, 3).map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  test("Last-Event-ID skips events already seen", async () => {
    const { driver, ctx, app } = setup();
    const { id, done } = await ctx.runs.start({});
    driver.emit({ type: "stage", stage: "building_map" });
    driver.emit({ type: "log", message: "one" });
    driver.finish({ ...ctx.runs.pendingRun(id)!, status: "complete" });
    await done;

    const res = await app.request(`/api/runs/${id}/events`, { headers: { "Last-Event-ID": "2" } });
    const msgs = await readAll(res);
    expect(msgs.map((m) => m.event)).toEqual(["done", "end"]);

    const viaQuery = await readAll(await app.request(`/api/runs/${id}/events?after=1`));
    expect(viaQuery.map((m) => m.id).filter(Boolean)).toEqual(["2", "3"]);
  });

  test("switches from replay to live without gaps or duplicates", async () => {
    const { driver, ctx, app } = setup();
    const { id, done } = await ctx.runs.start({});
    driver.emit({ type: "stage", stage: "building_map" });
    driver.emit({ type: "log", message: "before connect" });

    const res = await app.request(`/api/runs/${id}/events`);
    const reading = readAll(res);
    // Let the handler replay and switch to live before more events arrive.
    await Bun.sleep(20);
    driver.emit({ type: "log", message: "after connect 1" });
    driver.emit({ type: "log", message: "after connect 2" });
    driver.finish({ ...ctx.runs.pendingRun(id)!, status: "complete" });
    await done;

    const msgs = await reading;
    const ids = msgs.filter((m) => m.id).map((m) => Number(m.id));
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect(msgs.at(-1)?.event).toBe("end");
  });

  test("events emitted during replay are not lost", async () => {
    const { driver, ctx, app } = setup();
    const { id, done } = await ctx.runs.start({});
    for (let i = 0; i < 50; i++) driver.emit({ type: "log", message: `line ${i}` });

    const reading = readAll(await app.request(`/api/runs/${id}/events`));
    for (let i = 50; i < 100; i++) driver.emit({ type: "log", message: `line ${i}` });
    driver.finish({ ...ctx.runs.pendingRun(id)!, status: "complete" });
    await done;

    const ids = (await reading).filter((m) => m.id).map((m) => Number(m.id));
    expect(ids).toEqual(Array.from({ length: 101 }, (_, i) => i + 1));
  });

  test("events emitted while draining the replay buffer are not lost", async () => {
    const { driver, ctx, app } = setup();
    const { id, done } = await ctx.runs.start({});
    driver.emit({ type: "log", message: "stored before connecting" });

    const writeSSE = SSEStreamingApi.prototype.writeSSE;
    const writing = spyOn(SSEStreamingApi.prototype, "writeSSE").mockImplementation(
      async function (this: SSEStreamingApi, message) {
        // The file snapshot is already read: this event can only reach the buffer.
        if (message.id === "1") driver.emit({ type: "log", message: "during replay" });
        // This arrives after the buffer's first batch has been taken for writing.
        if (message.id === "2") driver.emit({ type: "log", message: "during buffer drain" });
        await writeSSE.call(this, message);
        if (message.id === "2") {
          // Finishing persists the run asynchronously, allowing the handoff to complete.
          driver.finish({ ...ctx.runs.pendingRun(id)!, status: "complete" });
        }
      },
    );

    try {
      const msgs = await readAll(await app.request(`/api/runs/${id}/events`));
      await done;
      expect(msgs.map((m) => m.id)).toEqual(["1", "2", "3", "4", undefined]);
      expect(msgs.map((m) => m.event)).toEqual(["log", "log", "log", "done", "end"]);
    } finally {
      writing.mockRestore();
    }
  });

  test.each(["done", "cancelled", "error"] as const)(
    "delivers %s emitted during the buffer drain before ending",
    async (terminal) => {
      const { driver, ctx, app } = setup();
      const { id, done } = await ctx.runs.start({});
      driver.emit({ type: "log", message: "stored before connecting" });

      const writeSSE = SSEStreamingApi.prototype.writeSSE;
      const writing = spyOn(SSEStreamingApi.prototype, "writeSSE").mockImplementation(
        async function (this: SSEStreamingApi, message) {
          if (message.id === "1") driver.emit({ type: "log", message: "during replay" });
          if (message.id === "2") {
            driver.emit({ type: "log", message: "before the terminal event" });
            if (terminal === "done") driver.finish({ ...ctx.runs.pendingRun(id)!, status: "complete" });
            else if (terminal === "cancelled") void ctx.runs.cancel(id);
            else driver.fail("test failure");
            // Keep the buffered write pending until the terminal event is also buffered.
            await done;
          }
          await writeSSE.call(this, message);
        },
      );

      try {
        const msgs = await readAll(await app.request(`/api/runs/${id}/events`));
        expect(msgs.map((m) => m.id)).toEqual(["1", "2", "3", "4", undefined]);
        expect(msgs.map((m) => m.event)).toEqual(["log", "log", "log", terminal, "end"]);
      } finally {
        writing.mockRestore();
      }
    },
  );

  test("404 for an unknown run", async () => {
    const { app } = setup();
    const res = await app.request("/api/runs/no-such-run/events");
    expect(res.status).toBe(404);
  });
});
