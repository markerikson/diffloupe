/**
 * Talks to a DiffLoupe server that is already running: finds one on the
 * usual ports, starts a run on it, and follows the run's event stream.
 */
import type { ErrorResponse, HealthResponse, StartRunRequest, StartRunResponse, StoredEvent } from "../server/types.ts";

const PROBE_TIMEOUT_MS = 500;
/** Same range the server tries when binding. */
const PORT_RANGE = 10;

export interface FoundServer {
  base: string;
  port: number;
  health: HealthResponse;
}

/** The health response of a DiffLoupe server on `port`, or null for nothing or something else. */
export async function probeServer(port: number): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<HealthResponse>;
    return body.app === "diffloupe" ? (body as HealthResponse) : null;
  } catch {
    return null;
  }
}

/** DiffLoupe servers on `first` and the ports after it, in port order. */
export async function findServers(first: number): Promise<FoundServer[]> {
  const ports = Array.from({ length: PORT_RANGE + 1 }, (_, i) => first + i).filter((p) => p <= 65535);
  const healths = await Promise.all(ports.map(probeServer));
  return ports.flatMap((port, i) => {
    const health = healths[i];
    return health ? [{ base: `http://localhost:${port}`, port, health }] : [];
  });
}

export class ServerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ServerRequestError";
  }
}

export async function postRun(base: string, req: StartRunRequest): Promise<StartRunResponse> {
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = (await res.json()) as StartRunResponse | ErrorResponse;
  if (!res.ok || "error" in body) {
    throw new ServerRequestError("error" in body ? body.error : `HTTP ${res.status}`, res.status);
  }
  return body;
}

export async function cancelRun(base: string, id: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Calls `onEvent` for each event of run `id` until the stream ends. Returns
 * the terminal event, or null when the stream closed without one.
 */
export async function followRun(
  base: string,
  id: string,
  onEvent: (e: StoredEvent) => void,
): Promise<StoredEvent | null> {
  let terminal: StoredEvent | null = null;
  let after = 0;
  for (let attempt = 0; attempt < 5 && !terminal; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${base}/api/runs/${encodeURIComponent(id)}/events?after=${after}`);
    } catch {
      await Bun.sleep(500);
      continue;
    }
    if (!res.ok || !res.body) return null;
    let ended = false;
    for await (const msg of sseMessages(res.body)) {
      if (msg.event === "end") {
        ended = true;
        break;
      }
      if (!msg.data) continue;
      const e = JSON.parse(msg.data) as StoredEvent;
      after = e.seq;
      onEvent(e);
      if (e.type === "done" || e.type === "cancelled" || e.type === "error") terminal = e;
    }
    if (ended) break;
  }
  return terminal;
}

interface SseMessage {
  event: string;
  data: string;
}

async function* sseMessages(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buf = "";
  let event = "message";
  let data: string[] = [];
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        if (data.length) yield { event, data: data.join("\n") };
        else if (event !== "message") yield { event, data: "" };
        event = "message";
        data = [];
      } else if (line.startsWith(":")) {
        continue;
      } else {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
    }
  }
}
