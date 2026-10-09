/**
 * The local server: JSON API under `/api`, the web UI (or a status page)
 * everywhere else. One review runs at a time.
 */
import { Hono } from "hono";
import { dataDir } from "../review/run-store.ts";
import { VERSION } from "../version.ts";
import { cleanupStale, probeGh, probeOpenCode, type ServerContext } from "./context.ts";
import { allowedHosts, hostGuard, isLoopbackHost, originGuard } from "./guards.ts";
import { healthRoutes } from "./routes/health.ts";
import { runsRoutes } from "./routes/runs.ts";
import { defaultDriver, RunManager } from "./run-manager.ts";
import { findWebDir, serveStatic } from "./static.ts";

export const DEFAULT_PORT = 4517;
export const DEFAULT_HOST = "127.0.0.1";
/** Ports tried after the requested one when it is taken. */
const PORT_ATTEMPTS = 10;

export function createApp(ctx: ServerContext, allowed: Set<string> = allowedHosts(DEFAULT_HOST)): Hono {
  const app = new Hono();
  app.use("*", hostGuard(allowed));
  app.use("*", originGuard());
  app.route("/api/health", healthRoutes(ctx));
  app.route("/api/runs", runsRoutes(ctx));
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  app.get("*", (c) => serveStatic(c, ctx.webDir));
  return app;
}

export interface StartServerOptions {
  host?: string;
  port?: number;
  /** Fail instead of trying the next ports when `port` is taken. */
  strictPort?: boolean;
  defaultRepo: string | null;
  log?: (message: string) => void;
}

export interface StartedServer {
  ctx: ServerContext;
  url: string;
  port: number;
  stop(): Promise<void>;
}

function isAddrInUse(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === "EADDRINUSE" || /address already in use|EADDRINUSE|port .* in use/i.test(e?.message ?? "");
}

export function serverUrl(host: string, port: number): string {
  if (isLoopbackHost(host) || host === "0.0.0.0" || host === "::") return `http://localhost:${port}`;
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export async function startServer(opts: StartServerOptions): Promise<StartedServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const first = opts.port ?? DEFAULT_PORT;
  const log = opts.log ?? ((m: string) => console.error(m));

  const [gh, opencode] = await Promise.all([probeGh(), probeOpenCode()]);
  await cleanupStale(opts.defaultRepo, log);

  const ctx: ServerContext = {
    version: VERSION,
    defaultRepo: opts.defaultRepo,
    dataDir: dataDir(),
    webDir: findWebDir(),
    gh,
    opencode,
    runs: new RunManager(defaultDriver(opts.defaultRepo ?? process.cwd())),
  };
  const allowed = allowedHosts(host);
  const app = createApp(ctx, allowed);

  const last = opts.strictPort ? first : Math.min(first + PORT_ATTEMPTS, 65535);
  let lastErr: unknown;
  for (let port = first; port <= last; port++) {
    try {
      const server = Bun.serve({ hostname: host, port, fetch: app.fetch, idleTimeout: 0 });
      if (!isLoopbackHost(host)) {
        log(`Warning: listening on ${host}; anyone who can reach this machine on port ${port} can start reviews.`);
      }
      return {
        ctx,
        url: serverUrl(host, port),
        port,
        stop: () => server.stop(true),
      };
    } catch (err) {
      if (!isAddrInUse(err)) throw err;
      lastErr = err;
    }
  }
  throw new Error(
    `no free port in ${first}-${last}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}
