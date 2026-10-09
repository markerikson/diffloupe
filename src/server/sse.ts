/**
 * `GET /api/runs/:id/events`: replays `events.jsonl` after the client's last
 * seen sequence number, then follows the live run. A finished run gets its
 * stored events and an `end` event.
 */
import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { readEvents, type RunManager } from "./run-manager.ts";
import type { StoredEvent, TerminalEventType } from "./types.ts";

const KEEPALIVE_MS = 15_000;
const TERMINAL: ReadonlySet<string> = new Set<TerminalEventType>(["done", "cancelled", "error"]);

function afterSeq(c: Context): number {
  const raw = c.req.header("last-event-id") ?? c.req.query("after") ?? "0";
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function streamRunEvents(c: Context, runs: RunManager, id: string): Response {
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");
  const after = afterSeq(c);

  return streamSSE(c, async (stream) => {
    let lastSent = after;
    let live: ((e: StoredEvent) => void) | null = null;
    const buffered: StoredEvent[] = [];
    let finished = false;
    let wake: (() => void) | null = null;

    const send = async (e: StoredEvent) => {
      if (e.seq <= lastSent) return;
      lastSent = e.seq;
      await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
      if (TERMINAL.has(e.type)) finished = true;
    };

    const sub = runs.subscribe(id, (e) => {
      if (live) live(e);
      else buffered.push(e);
    });
    stream.onAbort(() => {
      sub?.unsubscribe();
      finished = true;
      wake?.();
    });

    for (const e of await readEvents(id)) await send(e);
    for (const e of buffered.splice(0)) await send(e);

    if (!sub || finished) {
      await end(stream);
      sub?.unsubscribe();
      return;
    }

    const queue: StoredEvent[] = [];
    live = (e) => {
      queue.push(e);
      wake?.();
    };
    while (!finished && !stream.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, KEEPALIVE_MS);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
        if (queue.length === 0 && !finished && !stream.aborted) await stream.write(": keepalive\n\n");
        continue;
      }
      for (const e of queue.splice(0)) await send(e);
    }
    sub.unsubscribe();
    if (!stream.aborted) await end(stream);
  });
}

async function end(stream: SSEStreamingApi): Promise<void> {
  await stream.writeSSE({ event: "end", data: "{}" });
}
