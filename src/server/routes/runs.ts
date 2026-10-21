import { readFile } from "node:fs/promises";
import path from "node:path";
import { type } from "arktype";
import { Hono, type Context } from "hono";
import { run } from "../../review/core/lib/proc.ts";
import {
  deleteRun,
  InvalidRunError,
  InvalidStateError,
  listRuns,
  loadRun,
  loadState,
  runDir,
  updateState,
} from "../../review/run-store.ts";
import { emptyState, StateOpError, type StateOp } from "../../review/state-ops.ts";
import { TargetError } from "../../review/targets.ts";
import type { ReviewRun, RunUserState } from "../../types/review-run.ts";
import type { ServerContext } from "../context.ts";
import { RunBusyError } from "../run-manager.ts";
import { streamRunEvents } from "../sse.ts";
import {
  FileStateRequestSchema,
  FindingStateRequestSchema,
  StartRunRequestSchema,
  type ErrorResponse,
  type StartRunRequest,
  type StartRunResponse,
} from "../types.ts";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function validRunId(id: string): boolean {
  try {
    runDir(id);
    return true;
  } catch {
    return false;
  }
}

export function runsRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  async function findRun(id: string): Promise<ReviewRun | InvalidRunError | undefined> {
    const pending = ctx.runs.pendingRun(id);
    if (pending) return pending;
    if (!validRunId(id)) return undefined;
    try {
      return await loadRun(id);
    } catch (err) {
      if (err instanceof InvalidRunError) return err;
      return undefined;
    }
  }

  const notFound = (id: string): ErrorResponse => ({ error: `no run ${id}` });

  app.get("/", async (c) => c.json(await listRuns()));

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "request body must be JSON" } satisfies ErrorResponse, 400);
    }
    const req = StartRunRequestSchema(body);
    if (req instanceof type.errors) return c.json({ error: req.summary } satisfies ErrorResponse, 400);
    if (!req.repo && !req.fromRun && !ctx.defaultRepo) {
      return c.json({ error: "repo is required: the server was not started in a repository" } satisfies ErrorResponse, 400);
    }
    try {
      const { id } = await ctx.runs.start(req satisfies StartRunRequest);
      const url = new URL(`/runs/${id}`, c.req.url).href;
      return c.json({ id, url } satisfies StartRunResponse, 202);
    } catch (err) {
      if (err instanceof RunBusyError) {
        return c.json(
          { error: err.message, ...(err.activeRunId ? { activeRunId: err.activeRunId } : {}) } satisfies ErrorResponse,
          409,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message } satisfies ErrorResponse, err instanceof TargetError ? 400 : 500);
    }
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const found = await findRun(id);
    if (found instanceof InvalidRunError) return c.json({ error: found.message } satisfies ErrorResponse, 422);
    return found ? c.json(found) : c.json(notFound(id), 404);
  });

  app.get("/:id/diff", async (c) => {
    const id = c.req.param("id");
    if (!validRunId(id)) return c.json(notFound(id), 404);
    try {
      const patch = await readFile(path.join(runDir(id), "diff.patch"), "utf8");
      return c.text(patch, 200, { "Content-Type": "text/plain; charset=utf-8" });
    } catch {
      return c.json(notFound(id), 404);
    }
  });

  app.get("/:id/file", async (c) => {
    const id = c.req.param("id");
    const side = c.req.query("side");
    const filePath = c.req.query("path");
    if ((side !== "base" && side !== "head") || !filePath) {
      return c.json({ error: "side=base|head and path are required" } satisfies ErrorResponse, 400);
    }
    const found = await findRun(id);
    if (!found) return c.json(notFound(id), 404);
    if (found instanceof InvalidRunError) return c.json({ error: found.message } satisfies ErrorResponse, 422);
    const file = found.files.find((f) => f.path === filePath);
    if (!file) return c.json({ error: `${filePath} is not part of run ${id}` } satisfies ErrorResponse, 404);
    if ((side === "base" && file.status === "added") || (side === "head" && file.status === "removed")) {
      return c.json({ error: `${filePath} does not exist on the ${side} side` } satisfies ErrorResponse, 404);
    }
    if (file.isBinary) return c.json({ error: `${filePath} is a binary file` } satisfies ErrorResponse, 415);
    const sha = side === "base" ? found.base : found.head;
    const sidePath = side === "base" ? (file.previousPath ?? file.path) : file.path;
    const object = `${sha}:${sidePath}`;
    const size = await run("git", ["-C", found.repo.root, "cat-file", "-s", object], { allowFail: true });
    if (size.code !== 0) return c.json({ error: `cannot read ${object}` } satisfies ErrorResponse, 404);
    if (Number(size.stdout.trim()) > MAX_FILE_BYTES) {
      return c.json({ error: `${sidePath} is larger than 2 MB` } satisfies ErrorResponse, 413);
    }
    const shown = await run("git", ["-C", found.repo.root, "show", object], { allowFail: true });
    if (shown.code !== 0) return c.json({ error: `cannot read ${object}` } satisfies ErrorResponse, 404);
    return c.text(shown.stdout, 200, { "Content-Type": "text/plain; charset=utf-8" });
  });

  app.get("/:id/events", async (c) => {
    const id = c.req.param("id");
    if (!ctx.runs.isActive(id) && !(await findRun(id))) return c.json(notFound(id), 404);
    return streamRunEvents(c, ctx.runs, id);
  });

  app.get("/:id/state", async (c) => {
    const id = c.req.param("id");
    const found = await findRun(id);
    if (!found) return c.json(notFound(id), 404);
    if (ctx.runs.pendingRun(id)) return c.json(emptyState() satisfies RunUserState);
    return c.json(await loadState(id));
  });

  /** Validates the body, refuses while the run is active, and applies `op` to the saved state. */
  async function changeState<T>(
    c: Context,
    schema: (body: unknown) => T | type.errors,
    toOp: (body: T) => StateOp,
  ): Promise<Response> {
    const id = c.req.param("id") ?? "";
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "request body must be JSON" } satisfies ErrorResponse, 400);
    }
    const parsed = schema(body);
    if (parsed instanceof type.errors) return c.json({ error: parsed.summary } satisfies ErrorResponse, 400);
    if (ctx.runs.isActive(id)) {
      return c.json({ error: `run ${id} is still running`, activeRunId: id } satisfies ErrorResponse, 409);
    }
    const found = await findRun(id);
    if (!found) return c.json(notFound(id), 404);
    if (found instanceof InvalidRunError) return c.json({ error: found.message } satisfies ErrorResponse, 422);
    try {
      return c.json((await updateState(id, toOp(parsed))) satisfies RunUserState);
    } catch (err) {
      if (err instanceof StateOpError) return c.json({ error: err.message } satisfies ErrorResponse, 400);
      if (err instanceof InvalidStateError) return c.json({ error: err.message } satisfies ErrorResponse, 422);
      throw err;
    }
  }

  app.put("/:id/state/findings/:fid", (c) =>
    changeState(c, FindingStateRequestSchema, (body) => ({
      op: "finding",
      ids: [c.req.param("fid")],
      status: body.status,
      reason: body.reason,
      note: body.note,
      at: new Date().toISOString(),
    })),
  );

  app.put("/:id/state/files", (c) =>
    changeState(c, FileStateRequestSchema, (body) => ({ op: "reviewed", paths: [body.path], value: body.reviewed })),
  );

  app.post("/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const outcome = ctx.runs.cancel(id);
    if (!outcome) return c.json({ error: `run ${id} is not running` } satisfies ErrorResponse, 404);
    return c.json({ id, cancelling: true }, 202);
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (ctx.runs.isActive(id)) {
      return c.json({ error: `run ${id} is still running`, activeRunId: id } satisfies ErrorResponse, 409);
    }
    if (!(await findRun(id))) return c.json(notFound(id), 404);
    return c.json({ removed: await deleteRun(id) });
  });

  return app;
}
