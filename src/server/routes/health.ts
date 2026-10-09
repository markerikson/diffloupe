import { Hono } from "hono";
import type { ServerContext } from "../context.ts";
import type { HealthResponse } from "../types.ts";

export function healthRoutes(ctx: ServerContext): Hono {
  const app = new Hono();
  app.get("/", (c) =>
    c.json({
      app: "diffloupe",
      version: ctx.version,
      pid: process.pid,
      defaultRepo: ctx.defaultRepo,
      activeRunId: ctx.runs.activeRunId,
      gh: ctx.gh,
      opencode: ctx.opencode,
    } satisfies HealthResponse),
  );
  return app;
}
