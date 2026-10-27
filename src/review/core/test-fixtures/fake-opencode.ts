/** External OpenCode substitute: real processes, stdin, HTTP, and output files. */
import { closeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GovernorSessionConfig } from "../opencode/governor.ts";
import type { AgentUsage } from "../runner.ts";

export interface FakeResponse {
  payload?: unknown;
  reply?: string;
  exitCode?: number;
  hold?: boolean;
  usage?: { costUsd: number; numTurns: number; usage: AgentUsage };
}

export interface FakePlan {
  barrier?: number;
  importFailure?: boolean;
  importHold?: boolean;
  invalidLogin?: boolean;
  startup?: "hold" | "fail";
  sessionFailure?: "parent" | "child";
  sessionHold?: "parent" | "child";
  closeInput?: boolean;
  responses?: Record<string, FakeResponse>;
}

export interface FakeSession {
  parentID?: string;
  agent: string;
  title: string;
  model?: { providerID: string; id: string; variant?: string };
  permissions: { action: string; resource: string; effect: string }[];
  metadata: { diffloupe?: GovernorSessionConfig; diffloupeRun?: boolean };
}

export type FakeEvent =
  | { type: "process"; kind: string; pid: number; args: string[]; cwd: string; env: Record<string, string | undefined> }
  | { type: "import"; pid: number; input: string }
  | { type: "listening"; pid: number; url: string }
  | { type: "session"; pid: number; id: string; body: FakeSession }
  | { type: "run-start" | "run-finish"; pid: number; id: string; prompt: string }
  | { type: "interrupt" | "wait"; pid: number; id: string; search: string };

const plan: FakePlan = JSON.parse(process.env.FAKE_OPENCODE_PLAN ?? "{}");
const args = process.argv.slice(2);
const dataHome = process.env.XDG_DATA_HOME;
const stateHome = process.env.XDG_STATE_HOME;
const eventURL = process.env.FAKE_OPENCODE_EVENTS;
if (!args[0] || !dataHome || !stateHome || !eventURL) throw new Error("Missing fake OpenCode invocation settings");
const kind = args[0] === "auth" ? `auth-${args[1]}` : args[0];
const pid = process.pid;
const report = async (event: FakeEvent) => {
  const response = await fetch(`${eventURL}/event`, {
    method: "POST", body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error("Could not record fake OpenCode event");
};
const env = Object.fromEntries([
  "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CLI_CONFIG_CONTENT",
  "PWD", "OPENCODE_PASSWORD", "OPENAI_API_KEY", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_AUTOUPDATE",
  ...Object.keys(process.env).filter((key) => key.startsWith("REVIEW_GOVERNOR_")),
].map((key) => [key, process.env[key]]));
await report({ type: "process", kind, pid, args, cwd: process.cwd(), env });

if (kind === "auth-list") {
  console.log(JSON.stringify(plan.invalidLogin ? [] : [
    { id: "openai", connections: [{ type: "credential", id: "synthetic", method: "oauth" }] },
  ]));
} else if (kind === "auth-import") {
  const input = await Bun.stdin.text();
  await report({ type: "import", pid, input });
  if (plan.importHold) await fetch(`${eventURL}/hold`);
  if (plan.importFailure) {
    console.error("synthetic import failure");
    process.exitCode = 1;
  } else {
    await mkdir(dataHome, { recursive: true });
    await writeFile(path.join(dataHome, "opencode.db"), "synthetic credentials");
  }
} else if (kind === "serve") {
  if (plan.startup === "fail") process.exit(17);
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  if (plan.startup !== "hold") {
    const sessions = new Map<string, FakeSession>();
    let nextID = 0;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const held = new Map<string, () => void>();
    const authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`;
    const server: Bun.Server<undefined> = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 0,
      async fetch(request): Promise<Response> {
        if (request.headers.get("authorization") !== authorization) return new Response("unauthorized", { status: 401 });
        const url = new URL(request.url);
        if (url.pathname === "/api/info" && request.method === "GET") {
          return Response.json({ version: "2.1.2", urls: [server.url.origin] });
        }
        if (url.pathname === "/api/session" && request.method === "POST") {
          const body = await request.json() as FakeSession;
          if (plan.sessionFailure === (body.parentID ? "child" : "parent")) return new Response("failed", { status: 503 });
          const id = `session-${pid}-${++nextID}`;
          sessions.set(id, body);
          await report({ type: "session", pid, id, body });
          if (plan.sessionHold === (body.parentID ? "child" : "parent")) await new Promise<never>(() => {});
          return Response.json({ data: { id } });
        }
        const interrupt = url.pathname.match(/^\/api\/session\/([^/]+)\/interrupt$/);
        if (interrupt?.[1] && request.method === "POST") {
          const id = decodeURIComponent(interrupt[1]);
          await report({ type: "interrupt", pid, id, search: url.search });
          held.get(id)?.();
          return Response.json(true);
        }
        const wait = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/wait$/);
        if (wait?.[1] && request.method === "POST") {
          await report({ type: "wait", pid, id: decodeURIComponent(wait[1]), search: url.search });
          return Response.json(true);
        }
        // Private fixture endpoint stands in for the attached CLI's native transport.
        if (url.pathname === "/__run" && request.method === "POST") {
          const { id, prompt } = await request.json() as { id: string; prompt: string };
          const session = sessions.get(id);
          const config = session?.metadata.diffloupe;
          if (!config || !session?.parentID) return new Response("Only children may run", { status: 400 });
          const response = plan.responses?.[config.tag] ?? {};
          await report({ type: "run-start", pid, id, prompt });
          if (++arrivals >= (plan.barrier ?? 1)) release();
          await barrier;
          if (response.hold) await new Promise<void>((resolve) => held.set(id, resolve));
          if (response.reply === undefined && !response.exitCode && !response.hold) {
            await mkdir(path.dirname(config.outFile), { recursive: true });
            await writeFile(config.outFile, JSON.stringify(response.payload ?? {}));
          }
          if (response.usage) await writeFile(config.usageFile, JSON.stringify(response.usage));
          await writeFile(config.logFile, `${JSON.stringify({ sessionID: id, tag: config.tag })}\n`);
          await report({ type: "run-finish", pid, id, prompt });
          return Response.json({
            exitCode: response.exitCode ?? 0,
            // Deliberately disagrees with usage files to exercise accounting precedence.
            stdout: `${JSON.stringify({ type: "step_finish", part: { type: "step-finish", cost: 99, tokens: { input: 999 } } })}\n`
              + (response.reply === undefined ? "" : `${JSON.stringify({ type: "text", part: { type: "text", text: response.reply } })}\n`),
          });
        }
        return new Response("unexpected endpoint", { status: 404 });
      },
    });
    await mkdir(dataHome, { recursive: true });
    await mkdir(stateHome, { recursive: true });
    await writeFile(path.join(dataHome, "refreshed"), "retained refresh");
    await report({ type: "listening", pid, url: server.url.origin });
    console.log(JSON.stringify({ url: server.url.origin }));
  }
} else if (kind === "run") {
  if (plan.closeInput) {
    closeSync(0);
    // Stay alive until the runner observes the broken stdin and drains the process.
    await fetch(`${eventURL}/hold`);
  } else {
    const prompt = await Bun.stdin.text();
    const server = args[args.indexOf("--server") + 1];
    const id = args[args.indexOf("--session") + 1];
    if (!server || !id) throw new Error("Attached CLI requires a server and session");
    const response = await fetch(`${server}/__run`, {
      method: "POST", body: JSON.stringify({ id, prompt }),
      headers: { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}` },
    });
    if (!response.ok) throw new Error(`Attached fake CLI failed (${response.status})`);
    const result = await response.json() as { stdout: string; exitCode: number };
    process.stdout.write(result.stdout);
    process.exitCode = result.exitCode;
  }
} else {
  throw new Error(`Unexpected fake OpenCode command: ${args.join(" ")}`);
}
