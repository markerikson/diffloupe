import { type } from "arktype";
import { StoredEventSchema, type StoredEvent } from "../../server/types.ts";

const EVENT_TYPES = ["stage", "slice", "log", "cost", "budget", "done", "cancelled", "error"] as const;
const TERMINAL = new Set<string>(["done", "cancelled", "error"]);

export interface RunEventHandlers {
  onEvent(event: StoredEvent): void;
  /** Called once when the run finishes or the server ends the stream. */
  onEnd(): void;
}

/**
 * Follows `/api/runs/:id/events`. EventSource resumes from the last event id
 * on its own after a dropped connection. Returns a function that closes it.
 */
export function followRunEvents(id: string, handlers: RunEventHandlers): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  let ended = false;

  const finish = () => {
    if (ended) return;
    ended = true;
    source.close();
    handlers.onEnd();
  };

  const onMessage = (e: Event) => {
    // A connection failure also fires "error", as a plain Event without data.
    if (!(e instanceof MessageEvent)) {
      if (source.readyState === EventSource.CLOSED) finish();
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(String(e.data));
    } catch {
      console.warn(`[diffloupe] run ${id}: event is not JSON`, e.data);
      return;
    }
    const event = StoredEventSchema(raw);
    if (event instanceof type.errors) {
      console.warn(`[diffloupe] run ${id}: skipping malformed event: ${event.summary}`);
      return;
    }
    handlers.onEvent(event);
    if (TERMINAL.has(event.type)) finish();
  };

  for (const t of EVENT_TYPES) source.addEventListener(t, onMessage);
  source.addEventListener("end", finish);

  return () => {
    ended = true;
    source.close();
  };
}
