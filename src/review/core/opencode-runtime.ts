import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, openSync, writeSync } from "node:fs";
import { request } from "node:http";
import { subscriptionCommand } from "../subscription.ts";

export interface OpenCodeRuntime {
  url: string;
  password: string;
  /** Resolves after process exit and settlement of outstanding HTTP operations. */
  closed: Promise<void>;
  createSession(input: Record<string, unknown>): Promise<string>;
  /** Interrupt without resuming queued work, then await native tool cleanup. */
  interrupt(sessionID: string): Promise<void>;
  stop(graceMs?: number): Promise<void>;
  killNow(): void;
}

export interface OpenCodeRuntimeOptions {
  command: string;
  /** Plain CLI or worker prefix, followed by serve --stdio --hostname 127.0.0.1 --port 0. */
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  logFile?: string;
}

const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_LINE_LENGTH = 64 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePrivateServerArgs(args: string[]): void {
  const index = args.lastIndexOf("serve");
  const flags = args.slice(index + 1);
  const expected = new Map([["--stdio", ""], ["--hostname", "127.0.0.1"], ["--port", "0"]]);
  if (index >= 0) {
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      const value = expected.get(flag);
      if (value === undefined || (value && flags[++i] !== value)) break;
      expected.delete(flag);
      if (i === flags.length - 1 && expected.size === 0) return;
    }
  }
  throw new Error("OpenCode runtime requires serve --stdio --hostname 127.0.0.1 --port 0");
}

/**
 * Own one OpenCode 2.1.2 server, without the SDK's automatic discovery or retries.
 * --stdio emits {url} and leases the server to our open stdin. In particular,
 * an unexpectedly lost create response must never cause a second session POST.
 */
export async function startOpenCodeRuntime(opts: OpenCodeRuntimeOptions): Promise<OpenCodeRuntime> {
  opts.signal?.throwIfAborted();
  // Killing only a Windows wrapper cannot uphold this runtime's ownership
  // contract. A Windows implementation needs process-tree/job-object support.
  if (process.platform === "win32") throw new Error("OpenCode private runtime requires POSIX process groups");
  requirePrivateServerArgs(opts.args);
  // Only our exact worker invocation can suspend startup for a profile lock.
  // Reuse its command builder so source and bundled worker paths stay in sync.
  const home = opts.args[2];
  const wrapper = home && opts.args[4] === "serve" ? subscriptionCommand(home, opts.args.slice(4), "review") : undefined;
  let profilePhase: "starting" | "waiting" | "acquired" | undefined = wrapper && opts.command === wrapper.command &&
    opts.args.length === wrapper.args.length && opts.args.every((arg, index) => arg === wrapper.args[index])
    ? "starting" : undefined;
  const password = randomBytes(32).toString("hex");
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const env = { ...opts.env };
  for (const key of [
    "OPENCODE_HOST", "OPENCODE_HOSTNAME", "OPENCODE_PORT", "OPENCODE_SERVER",
    "OPENCODE_SERVER_URL", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME",
  ]) delete env[key];
  env.OPENCODE_PASSWORD = password;

  // Do not follow a symlink or leave a preexisting log world-readable.
  let logFD: number | undefined;
  if (opts.logFile !== undefined) {
    logFD = openSync(opts.logFile, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { fchmodSync(logFD, 0o600); } catch (error) { closeSync(logFD); throw error; }
  }
  const redact = (text: string) => text
    .replaceAll(password, "[redacted]")
    .replaceAll(authorization.slice(6), "[redacted]")
    .replace(/server password \S+/g, "server password [redacted]");
  const log = (line: string) => {
    if (logFD === undefined) return;
    try { writeSync(logFD, `${redact(line)}\n`); } catch {
      // A logging failure must not abandon a live server.
      try { closeSync(logFD); } catch { /* Already closed. */ }
      logFD = undefined;
    }
  };

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(opts.command, opts.args, { cwd: opts.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    if (logFD !== undefined) closeSync(logFD);
    throw error;
  }
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let stopping = false;
  let processClosed = false;
  let url = "";
  let stopPromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let resolveAddress!: (url: string) => void;
  let rejectAddress!: (error: Error) => void;
  const address = new Promise<string>((resolve, reject) => { resolveAddress = resolve; rejectAddress = reject; });
  let startupTimer: ReturnType<typeof setTimeout> | undefined;

  function startStartupTimer(): void {
    startupTimer = setTimeout(() => {
      beginShutdown(new Error("OpenCode server startup timed out"));
      signalGroup("SIGKILL");
    }, STARTUP_TIMEOUT_MS);
  }
  function signalGroup(signal: NodeJS.Signals): void {
    if (child.pid === undefined || processClosed) return;
    try {
      process.kill(-child.pid, signal);
    } catch { /* The process group has already exited. */ }
  }
  function beginShutdown(error: Error): void {
    stopping = true;
    clearTimeout(startupTimer);
    lifetime.abort(error);
    rejectAddress(error);
  }
  function killNow(): void {
    beginShutdown(new Error("OpenCode runtime stopped"));
    child.stdin.destroy();
    signalGroup("SIGKILL");
  }
  function stop(graceMs = 5000): Promise<void> {
    if (stopPromise) return stopPromise;
    beginShutdown(new Error("OpenCode runtime stopped"));
    child.stdin.end();
    // Signal descendants too: native tools may still be holding inherited pipes.
    signalGroup("SIGTERM");
    const delay = Number.isFinite(graceMs) ? Math.max(0, graceMs) : 5000;
    const timer = setTimeout(() => signalGroup("SIGKILL"), delay);
    stopPromise = closed.finally(() => { clearTimeout(timer); });
    return stopPromise;
  }
  function track<T>(operation: Promise<T>): Promise<T> {
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  }
  function http(method: "GET" | "POST", pathname: string, body?: Record<string, unknown>): Promise<unknown> {
    if (stopping) return Promise.reject(new Error("OpenCode runtime stopped"));
    return track(new Promise((resolve, reject) => {
      let payload: string | undefined;
      try { payload = body === undefined ? undefined : JSON.stringify(body); } catch (error) { reject(error); return; }
      const req = request(new URL(pathname, url), {
        method,
        agent: false,
        headers: {
          Authorization: authorization,
          ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
        },
      });
      let settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lifetime.signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => req.destroy(new Error("OpenCode runtime stopped"));
      const timer = setTimeout(() => req.destroy(new Error(`OpenCode ${method} ${pathname} timed out`)), REQUEST_TIMEOUT_MS);
      lifetime.signal.addEventListener("abort", abort, { once: true });
      req.on("error", (error) => finish(new Error(redact(error.message))));
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("error", () => finish(new Error(`OpenCode ${method} ${pathname} response interrupted`)));
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new Error("OpenCode response exceeds 1 MiB"));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
            finish(new Error(`OpenCode ${method} ${pathname} failed (HTTP ${res.statusCode ?? "unknown"})`));
            return;
          }
          if (res.statusCode === 204) { finish(); return; }
          try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch {
            finish(new Error(`OpenCode ${method} ${pathname} returned invalid JSON`));
          }
        });
      });
      if (lifetime.signal.aborted) abort();
      else req.end(payload);
    }));
  }

  // Redact complete lines, including secrets split across data events. Discard
  // oversized lines entirely instead of leaking a password across truncations.
  function readOutput(stream: typeof child.stdout, stdout: boolean): void {
    let buffer = "";
    let oversized = false;
    const line = (text: string) => {
      log(text);
      if (!stdout || url || stopping) return;
      let message: unknown;
      try { message = JSON.parse(text); } catch { return; }
      if (!object(message)) return;
      // Accept each transition once. Native output after acquisition (or a
      // plain CLI impersonating these messages) cannot extend the deadline.
      if (Object.keys(message).length === 1) {
        if (profilePhase === "starting" && message.diffloupe === "waiting-for-profile") {
          profilePhase = "waiting";
          clearTimeout(startupTimer);
          return;
        }
        if (profilePhase === "waiting" && message.diffloupe === "profile-acquired") {
          profilePhase = "acquired";
          startStartupTimer();
          return;
        }
      }
      if (typeof message.url !== "string") return;
      if (profilePhase === "waiting") {
        rejectAddress(new Error("OpenCode announced its server before acquiring the subscription profile"));
        return;
      }
      try {
        const parsed = new URL(message.url);
        if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.port === "0" ||
          parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
          throw new Error("Invalid private server URL");
        }
        url = parsed.origin;
        resolveAddress(url);
      } catch { rejectAddress(new Error("OpenCode announced an invalid loopback server URL")); }
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const parts = chunk.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (!oversized) {
          buffer += parts[i];
          if (buffer.length > MAX_LINE_LENGTH) { buffer = ""; oversized = true; }
        }
        if (i < parts.length - 1) {
          if (oversized) log("[OpenCode output line exceeds 64 KiB]"); else line(buffer);
          buffer = "";
          oversized = false;
        }
      }
    });
    stream.on("end", () => { if (buffer && !oversized) line(buffer); });
  }
  readOutput(child.stdout, true);
  readOutput(child.stderr, false);
  child.stdin.on("error", () => { /* Exit/close handles an early stdin close. */ });
  child.on("error", (error) => {
    log(`OpenCode could not start: ${error.message}`);
    beginShutdown(new Error(`OpenCode could not start: ${redact(error.message)}`));
  });
  child.once("exit", (code, signal) => {
    beginShutdown(new Error(`OpenCode server exited (${signal ?? code ?? "unknown"})`));
    // Even an exited wrapper can leave descendants keeping its pipes open.
    signalGroup("SIGKILL");
  });
  child.once("close", () => {
    processClosed = true;
    beginShutdown(new Error("OpenCode server closed"));
    process.removeListener("exit", killNow);
    opts.signal?.removeEventListener("abort", onAbort);
    if (logFD !== undefined) { closeSync(logFD); logFD = undefined; }
    void Promise.allSettled([...pending]).then(resolveClosed);
  });
  const onAbort = () => killNow();
  process.once("exit", killNow);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();
  if (!stopping) startStartupTimer();

  try {
    await address;
    const info = await http("GET", "/api/info");
    if (!object(info) || typeof info.version !== "string" || !Array.isArray(info.urls) || !info.urls.includes(url)) {
      throw new Error("OpenCode returned invalid server info");
    }
    if (stopping) throw new Error("OpenCode runtime stopped during startup");
    return {
      url, password, closed, stop, killNow,
      createSession(input) {
        return track((async () => {
          const response = await http("POST", "/api/session", input);
          if (stopping) throw new Error("OpenCode runtime stopped");
          if (!object(response) || !object(response.data) || typeof response.data.id !== "string" || !response.data.id) {
            throw new Error("OpenCode returned an invalid session ID");
          }
          return response.data.id;
        })());
      },
      interrupt(sessionID) {
        return track((async () => {
          const id = encodeURIComponent(sessionID);
          await http("POST", `/api/session/${id}/interrupt?resume=false`);
          await http("POST", `/api/experimental/session/${id}/wait`);
        })());
      },
    };
  } catch (error) {
    killNow();
    await closed;
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
}
