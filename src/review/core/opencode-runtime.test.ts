import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startOpenCodeRuntime, type OpenCodeRuntime, type OpenCodeRuntimeOptions } from "./opencode-runtime.ts";

// This process is the external native CLI/HTTP boundary. Nothing inside the
// runtime (spawn, transport, timers, process groups) is mocked.
const FAKE = String.raw`
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");
const mode = process.env.FAKE_MODE;
const record = (event) => fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify(event) + "\n");
record({ event: "started", pid: process.pid, cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("OPENCODE_"))) });
if (mode === "startup-failure") {
  process.stderr.write("native startup failed\n");
  process.exit(17);
}
if (mode === "wrapper") {
  const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {
    env: { ...process.env, FAKE_MODE: "normal" }, stdio: "inherit"
  });
  process.on("SIGTERM", () => {});
  child.on("exit", (code) => process.exit(code || 0));
} else {
let descendant;
if (mode === "stubborn" || mode === "startup-hang") {
  descendant = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: "inherit" });
  record({ event: "descendant", pid: descendant.pid });
}
process.on("SIGTERM", () => {
  record({ event: "term" });
  if (mode !== "stubborn" && mode !== "startup-hang") process.exit(0);
});
process.stdin.resume();
process.stdin.on("end", () => {
  record({ event: "eof" });
  if (mode !== "stubborn" && mode !== "startup-hang") process.exit(0);
});
if (mode === "startup-hang") {
  setInterval(() => {}, 1000);
} else {
let url;
let sequence = 0;
let inflight = 0;
const expectedAuth = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64");
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== expectedAuth || mode === "auth-failure") {
    res.writeHead(401); res.end(); return;
  }
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    record({ event: "request", method: req.method, path: req.url, body });
    const json = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/api/info") {
      if (mode === "info-hang") return;
      return json({ version: "2.1.2", pid: process.pid, urls: [url] });
    }
    if (req.url === "/api/session" && req.method === "POST") {
      const input = JSON.parse(body);
      const id = "ses_" + (++sequence);
      record({ event: "create", input, id, inflight: ++inflight });
      if (input.title === "hang") return;
      if (input.title === "lost-response") { req.socket.destroy(); return; }
      if (input.title === "invalid-envelope") return json({ id });
      if (input.title === "invalid-json") { res.end("broken"); return; }
      if (input.title === "failure") return json({ error: "native error" }, 503);
      if (input.title === "oversized") { res.end("x".repeat(1024 * 1024 + 1)); return; }
      if (input.title === "redirect") {
        res.writeHead(307, { Location: url + "/api/session" }); res.end(); return;
      }
      if (input.title === "exit") { process.exit(19); }
      if (input.title === "partial-response") { res.writeHead(200); res.write('{"data":'); return; }
      setTimeout(() => { --inflight; json({ data: { ...input, id } }); }, 40);
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/interrupt?resume=false")) {
      return json({ interrupted: true });
    }
    if (req.method === "POST" && req.url.startsWith("/api/experimental/session/") && req.url.endsWith("/wait")) {
      setTimeout(() => {
        record({ event: "settled" });
        res.writeHead(204); res.end();
      }, 80);
      return;
    }
    json({ error: "wrong endpoint" }, 404);
  });
});
server.listen(0, "127.0.0.1", () => {
  url = "http://127.0.0.1:" + server.address().port;
  // Splitting a password across writes must not defeat logfile redaction.
  const secret = process.env.OPENCODE_PASSWORD;
  process.stderr.write("diagnostic " + secret.slice(0, 11));
  setTimeout(() => {
    process.stderr.write(secret.slice(11) + " " + expectedAuth + "\n");
    const ready = JSON.stringify({ url: mode === "unsafe-url" ? "http://192.0.2.1:8080" : url }) + "\n";
    process.stdout.write(ready.slice(0, 9));
    setTimeout(() => process.stdout.write(ready.slice(9)), 5);
  }, 5);
});
}
}
`;

const directories: string[] = [];
const runtimes: OpenCodeRuntime[] = [];
type Event = Record<string, unknown>;

async function fixture(mode = "normal"): Promise<OpenCodeRuntimeOptions & { record: string }> {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "diffloupe-runtime-test-")));
  directories.push(cwd);
  const script = path.join(cwd, "fake-opencode.cjs");
  await writeFile(script, FAKE);
  const record = path.join(cwd, "events.jsonl");
  return {
    command: process.execPath,
    args: [script, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
    cwd,
    env: { PATH: process.env.PATH, FAKE_MODE: mode, FAKE_RECORD: record },
    logFile: path.join(cwd, "server.log"),
    record,
  };
}

async function start(opts: OpenCodeRuntimeOptions): Promise<OpenCodeRuntime> {
  const runtime = await startOpenCodeRuntime(opts);
  runtimes.push(runtime);
  return runtime;
}

async function events(file: string): Promise<Event[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  // eslint-disable-next-line no-await-in-loop -- Each poll observes a later external process state.
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for external process");
    // eslint-disable-next-line no-await-in-loop -- Give the external process time to make progress.
    await Bun.sleep(10);
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function expectProcessesGone(record: string): Promise<void> {
  const pids = (await events(record)).filter((event) => event.pid).map((event) => event.pid as number);
  expect(pids.length).toBeGreaterThan(0);
  await until(() => pids.every((pid) => !alive(pid)));
}

afterEach(async () => {
  const running = runtimes.splice(0);
  for (const runtime of running) runtime.killNow();
  await Promise.all(running.map((runtime) => runtime.closed));
  // killNow is synchronous; directory removal must wait for native exit.
  await Promise.all(directories.map(async (directory) => {
    const recorded = path.join(directory, "events.jsonl");
    if (existsSync(recorded)) await expectProcessesGone(recorded);
  }));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OpenCode private runtime", () => {
  test("authenticates an ephemeral loopback server and creates concurrent native children", async () => {
    const opts = await fixture("wrapper");
    Object.assign(opts.env, {
      OPENCODE_HOST: "0.0.0.0", OPENCODE_HOSTNAME: "elsewhere", OPENCODE_PORT: "4096",
      OPENCODE_SERVER: "https://example.invalid", OPENCODE_SERVER_URL: "https://example.invalid",
      OPENCODE_PASSWORD: "ambient-password", OPENCODE_SERVER_PASSWORD: "ambient-v1", OPENCODE_SERVER_USERNAME: "ambient-user",
    });
    const runtime = await start(opts);
    expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(runtime.password).toMatch(/^[a-f0-9]{64}$/);
    expect((await fetch(`${runtime.url}/api/info`)).status).toBe(401);
    const parent = await runtime.createSession({ title: "review", location: { directory: opts.cwd } });
    const input = {
      parentID: parent, model: { providerID: "test", id: "fake" }, agent: "review",
      permissions: [{ action: "*", resource: "*", effect: "deny" }], metadata: { tag: "child" },
    };
    const children = await Promise.all(Array.from({ length: 6 }, () => runtime.createSession(input)));
    expect(new Set(children).size).toBe(6);
    const recorded = await events(opts.record);
    const starts = recorded.filter((event) => event.event === "started");
    expect(starts).toHaveLength(2);
    for (const event of starts) {
      expect(event.cwd).toBe(opts.cwd);
      expect(event.env).toEqual({ OPENCODE_PASSWORD: runtime.password });
    }
    const creates = recorded.filter((event) => event.event === "create");
    expect(creates.slice(1).map((event) => event.input)).toEqual(Array(6).fill(input));
    expect(Math.max(...creates.map((event) => Number(event.inflight)))).toBe(6);
    await runtime.stop();
    await runtime.closed;
    await expectProcessesGone(opts.record);
    const log = await readFile(opts.logFile!, "utf8");
    expect(log).toContain("[redacted]");
    expect(log).not.toContain(runtime.password);
    expect(log).not.toContain(Buffer.from(`opencode:${runtime.password}`).toString("base64"));
    expect((await stat(opts.logFile!)).mode & 0o777).toBe(0o600);
  });

  test("interrupt waits for native cleanup with the exact no-resume query and no bodies", async () => {
    const opts = await fixture();
    const runtime = await start(opts);
    await runtime.interrupt("ses_child/with?characters");
    const recorded = await events(opts.record);
    expect(recorded.filter((event) => event.event === "request").slice(1)).toEqual([
      { event: "request", method: "POST", path: "/api/session/ses_child%2Fwith%3Fcharacters/interrupt?resume=false", body: "" },
      { event: "request", method: "POST", path: "/api/experimental/session/ses_child%2Fwith%3Fcharacters/wait", body: "" },
    ]);
    expect(recorded.at(-1)?.event).toBe("settled");
  });

  test("never retries a lost session response, HTTP error, or redirect", async () => {
    const opts = await fixture();
    const runtime = await start(opts);
    await expect(runtime.createSession({ title: "lost-response" })).rejects.toThrow();
    await expect(runtime.createSession({ title: "failure" })).rejects.toThrow("HTTP 503");
    await expect(runtime.createSession({ title: "redirect" })).rejects.toThrow("HTTP 307");
    expect((await events(opts.record)).filter((event) => event.event === "create")).toHaveLength(3);
    expect(await runtime.createSession({ title: "still usable" })).toBe("ses_4");
  });

  test("rejects invalid session responses and bounds response size", async () => {
    const runtime = await start(await fixture());
    await expect(runtime.createSession({ title: "invalid-envelope" })).rejects.toThrow("invalid session ID");
    await expect(runtime.createSession({ title: "invalid-json" })).rejects.toThrow("invalid JSON");
    await expect(runtime.createSession({ title: "oversized" })).rejects.toThrow();
  });

  test("stop drains pending creates, rejects later creates, and escalates the whole process group", async () => {
    const opts = await fixture("stubborn");
    const runtime = await start(opts);
    const creating = runtime.createSession({ title: "hang" }).catch((error: unknown) => error);
    await until(async () => (await events(opts.record)).some((event) => event.event === "create"));
    const stopping = runtime.stop(40);
    expect(runtime.stop(5000)).toBe(stopping);
    await expect(runtime.createSession({ title: "too late" })).rejects.toThrow("stopped");
    await stopping;
    expect(await creating).toBeInstanceOf(Error);
    await expectProcessesGone(opts.record);
    expect((await events(opts.record)).filter((event) => event.event === "create")).toHaveLength(1);
  });

  test("killNow settles partial response bodies and closes the server", async () => {
    const opts = await fixture("stubborn");
    const runtime = await start(opts);
    const pending = runtime.createSession({ title: "partial-response" }).catch((error: unknown) => error);
    await until(async () => (await events(opts.record)).some((event) => event.event === "create"));
    runtime.killNow();
    await runtime.closed;
    expect(await pending).toBeInstanceOf(Error);
    await expectProcessesGone(opts.record);
  });

  test("unexpected server exit rejects pending work and makes closed observable", async () => {
    const opts = await fixture();
    const runtime = await start(opts);
    await expect(runtime.createSession({ title: "exit" })).rejects.toThrow();
    await runtime.closed;
    await expect(runtime.createSession({})).rejects.toThrow("stopped");
    await expectProcessesGone(opts.record);
  });

  test("reports spawn failures and pre-readiness process exits", async () => {
    const opts = await fixture("startup-failure");
    await expect(startOpenCodeRuntime({ ...opts, command: path.join(opts.cwd, "missing") })).rejects.toThrow("could not start");
    await expect(startOpenCodeRuntime(opts)).rejects.toThrow("17");
    await expectProcessesGone(opts.record);
  });

  test("rejects unsafe readiness URLs and failed authenticated readiness", async () => {
    const unsafe = await fixture("unsafe-url");
    await expect(startOpenCodeRuntime(unsafe)).rejects.toThrow("loopback");
    await expectProcessesGone(unsafe.record);
    const auth = await fixture("auth-failure");
    await expect(startOpenCodeRuntime(auth)).rejects.toThrow("HTTP 401");
    await expectProcessesGone(auth.record);
  });

  test("cancellation during startup waits for the server and descendants to exit", async () => {
    const opts = await fixture("startup-hang");
    const controller = new AbortController();
    const starting = startOpenCodeRuntime({ ...opts, signal: controller.signal }).catch((error: unknown) => error);
    await until(async () => (await events(opts.record)).some((event) => event.event === "descendant"));
    controller.abort();
    expect(await starting).toBeInstanceOf(Error);
    await expectProcessesGone(opts.record);
  });

  test("cancellation during the HTTP readiness probe drains that request", async () => {
    const opts = await fixture("info-hang");
    const controller = new AbortController();
    const starting = startOpenCodeRuntime({ ...opts, signal: controller.signal }).catch((error: unknown) => error);
    await until(async () => (await events(opts.record)).some((event) => event.path === "/api/info"));
    controller.abort();
    expect(await starting).toBeInstanceOf(Error);
    await expectProcessesGone(opts.record);
  });

  test("the owning process exit hook kills a server still starting and its descendants", async () => {
    const opts = await fixture("startup-hang");
    const driver = path.join(opts.cwd, "owner.ts");
    await writeFile(driver, `
      import { readFileSync } from "node:fs";
      import { startOpenCodeRuntime } from ${JSON.stringify(path.join(import.meta.dir, "opencode-runtime.ts"))};
      void startOpenCodeRuntime(${JSON.stringify(opts)}).catch(() => {});
      setInterval(() => {
        try {
          if (readFileSync(${JSON.stringify(opts.record)}, "utf8").includes('"event":"descendant"')) process.exit(0);
        } catch {}
      }, 10);
      setTimeout(() => process.exit(42), 2000);
    `);
    const owner = spawn(process.execPath, ["--no-env-file", driver], { stdio: "ignore" });
    const code = await new Promise<number | null>((resolve, reject) => {
      owner.once("error", reject);
      owner.once("close", resolve);
    });
    expect(code).toBe(0);
    await expectProcessesGone(opts.record);
  });

  test("pre-aborted signals and incorrect launch flags never start a process", async () => {
    const opts = await fixture();
    await expect(startOpenCodeRuntime({ ...opts, signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(startOpenCodeRuntime({ ...opts, args: ["serve", "--hostname", "0.0.0.0"] })).rejects.toThrow("requires");
    expect(existsSync(opts.record)).toBe(false);
  });

  test("bounds startup and incomplete HTTP response bodies with real deadlines", async () => {
    const stalled = await fixture("startup-hang");
    const starting = startOpenCodeRuntime(stalled).catch((error: unknown) => error);
    const opts = await fixture();
    const runtime = await start(opts);
    const requesting = runtime.createSession({ title: "partial-response" }).catch((error: unknown) => error);
    const [startupError, requestError] = await Promise.all([starting, requesting]);
    expect(startupError).toBeInstanceOf(Error);
    expect((startupError as Error).message).toContain("startup timed out");
    expect(requestError).toBeInstanceOf(Error);
    expect((requestError as Error).message).toContain("timed out");
    await expectProcessesGone(stalled.record);
    expect((await events(opts.record)).filter((event) => event.event === "create")).toHaveLength(1);
  }, 40_000);
});
