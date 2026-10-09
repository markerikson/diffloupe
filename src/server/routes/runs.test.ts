import { describe, expect, test } from "bun:test";
import { createApp } from "../index.ts";
import { TargetError } from "../../review/targets.ts";
import { FakeDriver, fakeContext, useTempDataDir } from "../test-helpers.ts";

useTempDataDir();

function setup() {
  const driver = new FakeDriver();
  const ctx = fakeContext(driver);
  return { driver, ctx, app: createApp(ctx) };
}

function post(body?: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe("runs routes", () => {
  test("POST starts a run, a second POST gets 409, cancel ends it", async () => {
    const { ctx, app } = setup();
    const res = await app.request("/api/runs", post({ target: "HEAD" }));
    expect(res.status).toBe(202);
    const { id, url } = (await res.json()) as { id: string; url: string };
    expect(url).toEndWith(`/runs/${id}`);

    const busy = await app.request("/api/runs", post({ target: "HEAD" }));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ activeRunId: id });

    const health = (await (await app.request("/api/health")).json()) as { activeRunId: string | null };
    expect(health.activeRunId).toBe(id);

    const pending = await app.request(`/api/runs/${id}`);
    expect(((await pending.json()) as { status: string }).status).toBe("running");

    expect((await app.request(`/api/runs/${id}`, { method: "DELETE" })).status).toBe(409);

    const cancel = await app.request(`/api/runs/${id}/cancel`, post());
    expect(cancel.status).toBe(202);
    await ctx.runs.cancel(id);
    expect(ctx.runs.activeRunId).toBeNull();
    expect((await app.request(`/api/runs/${id}/cancel`, post())).status).toBe(404);
  });

  test("rejects unknown fields and bad values", async () => {
    const { app } = setup();
    expect((await app.request("/api/runs", post({ target: "HEAD", nope: 1 }))).status).toBe(400);
    expect((await app.request("/api/runs", post({ maxCostUsd: -1 }))).status).toBe(400);
    const notJson = await app.request("/api/runs", { method: "POST", body: "{" });
    expect(notJson.status).toBe(400);
  });

  test("a bad target is a 400", async () => {
    const { driver, app } = setup();
    driver.prepareError = new TargetError("unknown revision 'nope'");
    const res = await app.request("/api/runs", post({ target: "nope" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown revision 'nope'" });
  });

  test("lists, reads, and deletes finished runs", async () => {
    const { driver, ctx, app } = setup();
    const { id, done } = await ctx.runs.start({});
    driver.finish({ ...ctx.runs.pendingRun(id)!, status: "complete" });
    await done;

    const list = (await (await app.request("/api/runs")).json()) as Array<{ id: string }>;
    expect(list.some((r) => r.id === id)).toBe(true);

    const run = (await (await app.request(`/api/runs/${id}`)).json()) as { status: string };
    expect(run.status).toBe("complete");

    expect((await app.request(`/api/runs/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/api/runs/${id}`)).status).toBe(404);
  });

  test("file requires a path that belongs to the run", async () => {
    const { driver, ctx, app } = setup();
    const { id, done } = await ctx.runs.start({});
    driver.finish({ ...ctx.runs.pendingRun(id)!, status: "complete" });
    await done;
    const res = await app.request(`/api/runs/${id}/file?side=head&path=/etc/passwd`);
    expect(res.status).toBe(404);
    expect((await app.request(`/api/runs/${id}/file?side=sideways&path=x`)).status).toBe(400);
  });
});
