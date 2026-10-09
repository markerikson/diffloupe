import { describe, expect, test } from "bun:test";
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

  test("404 for an unknown run", async () => {
    const { app } = setup();
    const res = await app.request("/api/runs/no-such-run/events");
    expect(res.status).toBe(404);
  });
});
