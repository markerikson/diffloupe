import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { ensureDir, exists, readText, removeIfPresent, writeJson, writeText } from "./lib/io.ts";
import {
  DIR,
  SUBJECT,
  ARTIFACTS,
  PROVIDER,
  MAX_STEPS,
  DEADLINE_MS,
  MODEL,
  EFFORT,
  OUT,
  SIGNAL,
  PROVIDERS,
  CHILD_ENV,
  AUTH_IMPORT,
  SUBSCRIPTION_HOME,
  repoName,
} from "./config.ts";
import { run } from "./lib/proc.ts";
import { subscriptionCommand, subscriptionEnv } from "../subscription.ts";
import { startOpenCodeRuntime, type OpenCodeRuntime } from "./opencode-runtime.ts";
import type { GovernorSessionConfig } from "./opencode/governor.ts";

// ---------------------------------------------------------------- cancellation

export class CancelledError extends Error {
  override name = "CancelledError";
  constructor() {
    super("review cancelled");
  }
}

/**
 * Attached clients and owned servers are tracked separately. Servers own MCP
 * and shell descendants; shutdown drains both before releasing the checkout.
 * Detached process groups require explicit forwarding of terminal cancellation.
 */
const liveAgents = new Map<ChildProcess, Promise<void>>();
const liveServers = new Set<OpenCodeRuntime>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", killAgentsNow);
}

function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    // The group is already gone.
  }
}

/** Sends SIGKILL to every live agent group without waiting. */
export function killAgentsNow(): void {
  for (const child of liveAgents.keys()) signalGroup(child, "SIGKILL");
  for (const server of liveServers) server.killNow();
}

/**
 * SIGTERM to every live agent's process group, then SIGKILL after `graceMs`
 * for any that have not closed. Resolves when all have closed.
 */
export function killAgents(graceMs = 5000): Promise<void> {
  if (stopping) return stopping;
  runtimeAbort.abort();
  return stopping = (async () => {
    const pending = [...liveAgents];
    for (const [child] of pending) signalGroup(child, "SIGTERM");
    const timer = setTimeout(() => {
      for (const [child] of pending) if (liveAgents.has(child)) signalGroup(child, "SIGKILL");
    }, graceMs);
    try {
      await Promise.allSettled([...runtimes.values()].map(async (ready) => (await ready).server.stop(graceMs)));
      await Promise.allSettled([...pendingAgents]);
      await Promise.all(pending.map(([, closed]) => closed));
      // Only disposable run data lives here. The subscription database is
      // outside this directory and stays with OpenCode after shutdown.
      if (configHome && process.env.DIFFLOUPE_KEEP_SCRATCH !== "1") {
        const home = await configHome.catch(() => undefined);
        if (home) await rm(home, { recursive: true, force: true });
      }
    } finally {
      clearTimeout(timer);
    }
  })();
}

export function liveAgentCount(): number {
  return liveAgents.size;
}

// ---------------------------------------------------------------- agent

/**
 * How to spawn one agent invocation, and how to read its accounting back.
 *
 * The attached CLI preserves OpenCode's NDJSON format while the owned server
 * manages authentication and all of the run's native child sessions.
 */
export type Invocation = {
  command: string;
  args: string[];
  /** Directory the child reviews in. Always the PR's checkout, never the pipeline's. */
  cwd: string;
  /** Extra environment for the child. Merged over the inherited environment. */
  env: Record<string, string>;
  /** Variables to unset in the child, so ambient config cannot leak in. */
  unsetEnv: string[];
  /** Extension for the raw stdout capture, since one runner streams NDJSON. */
  rawExt: string;
  parse(stdout: string): { costUsd: number; numTurns: number; usage: AgentUsage | null };
  /** What the agent did with its tools. Only the streaming runner reports calls. */
  tools?(stdout: string): ToolSummary;
};

/**
 * The tool restriction below is a guardrail, not a sandbox, and should not be
 * described as one. Editing is refused to stop a reviewer rewriting the file it
 * is reading: slices share one checkout, and the line verification that decides
 * which findings survive reads it too. Writing has to stay — it is how a slice
 * delivers its findings — and Bash can write anything Write can. The prompts are
 * built from PR text, so treat a slice as capable of whatever Bash is. What
 * actually contains it is elsewhere: this process holds no token that can post,
 * the checkout is disposable and separate from the developer's, and post.ts
 * rebuilds every endpoint from outside the payload file.
 */
/** One event from `opencode run --format json`, which streams NDJSON. */
export type StreamEvent = {
  type?: string;
  part?: {
    type?: string;
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
};

/**
 * Token totals for one agent invocation. `first_step` is the first request of
 * the session alone, which shows whether the shared prompt prefix hit the
 * provider's prompt cache.
 */
export type AgentUsage = {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  first_step?: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
};

/**
 * Cost and token accounting from an `opencode run --format json` stream.
 *
 * The other runner reports one total for the whole invocation. This one reports
 * per step, so the total is the sum and the turn count is how many steps there
 * were. Anything unparseable is skipped rather than throwing: the accounting is
 * for the run record, and losing a line of it must not cost a paid review.
 */
export function sumOpenCodeStream(stdout: string): { costUsd: number; numTurns: number; usage: AgentUsage } {
  let costUsd = 0;
  let numTurns = 0;
  const usage: AgentUsage = {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      continue;
    }
    const part = event.part;
    // The stream and the plugin API disagree on the separator in this one name,
    // and which one arrives is not worth depending on.
    const isStep =
      part?.type === "step-finish" || part?.type === "step_finish" || event.type === "step_finish";
    if (!isStep || !part) continue;
    numTurns += 1;
    if (numTurns === 1) {
      usage.first_step = {
        input_tokens: part.tokens?.input ?? 0,
        cache_read_input_tokens: part.tokens?.cache?.read ?? 0,
        cache_creation_input_tokens: part.tokens?.cache?.write ?? 0,
      };
    }
    costUsd += part.cost ?? 0;
    usage.input_tokens += part.tokens?.input ?? 0;
    usage.output_tokens += part.tokens?.output ?? 0;
    usage.reasoning_tokens += part.tokens?.reasoning ?? 0;
    usage.cache_read_input_tokens += part.tokens?.cache?.read ?? 0;
    usage.cache_creation_input_tokens += part.tokens?.cache?.write ?? 0;
  }
  return { costUsd, numTurns, usage };
}

/** Per-invocation tool use, kept in the run record so a clean pass can be checked. */
export type ToolSummary = {
  /** Calls per tool name, including refused and failed ones. */
  calls: Record<string, number>;
  failed: number;
  /** Files opened through a read tool, as `path` or `path:section`, first-read order. */
  read: string[];
  /** Search queries and patterns, first-use order. */
  searched: string[];
};

export const READ_TOOLS = new Set(["read", "tilth_tilth_read"]);
export const SEARCH_TOOLS = new Set(["grep", "glob", "tilth_tilth_search", "tilth_tilth_files"]);
export const MAX_SUMMARY_ENTRIES = 60;

/**
 * Tool calls from an `opencode run --format json` stream. Paths under `cwd` are
 * made relative to it. Lists are capped so a runaway slice cannot bloat the run
 * record; the raw stream keeps everything.
 */
export function summarizeOpenCodeTools(stdout: string, cwd = ""): ToolSummary {
  const calls: Record<string, number> = {};
  let failed = 0;
  const read = new Set<string>();
  const searched = new Set<string>();
  const prefix = cwd ? `${cwd.replace(/\/$/, "")}/` : "";
  const rel = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const add = (set: Set<string>, value: string) => {
    if (set.size < MAX_SUMMARY_ENTRIES) set.add(value);
  };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: { type?: string; part?: { type?: string; tool?: string; state?: { status?: string; input?: unknown } } };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const part = event.part;
    if (event.type !== "tool_use" || part?.type !== "tool" || typeof part.tool !== "string") continue;
    calls[part.tool] = (calls[part.tool] ?? 0) + 1;
    if (part.state?.status === "error") failed += 1;
    const input = (part.state?.input ?? {}) as Record<string, unknown>;
    if (READ_TOOLS.has(part.tool)) {
      const paths = Array.isArray(input.paths) ? input.paths : [input.path ?? input.filePath];
      const section = typeof input.section === "string" ? `:${input.section}` : "";
      for (const p of paths) if (typeof p === "string") add(read, rel(p) + section);
    } else if (SEARCH_TOOLS.has(part.tool)) {
      const q = input.query ?? input.pattern;
      if (typeof q === "string") add(searched, q);
    }
  }
  return { calls, failed, read: [...read], searched: [...searched] };
}

/**
 * - `repo`: read, search and shell tools plus tilth, for agents that explore the checkout.
 * - `none`: only the write that delivers the answer; the prompt holds everything the agent sees.
 */
export type AgentTools = "repo" | "none";

/**
 * A named system prompt other than the reviewer contract. Its text belongs to
 * the child session, so concurrent tasks can use different instructions.
 */
export interface AgentSystem {
  name: string;
  text: string;
}

let configHome: Promise<string> | undefined;

/** One isolated configuration for the run; child prompts and limits live on sessions. */
export function openCodeConfig(): Promise<string> {
  return configHome ??= (async () => {
    const home = path.join(OUT, "oc", "shared");
    const configDir = path.join(home, "config");
    await writeJson(path.join(configDir, "opencode.json"), openCodeSettings());
    await writeText(path.join(configDir, "plugin", "governor.ts"), await readText(path.join(DIR, "opencode", "governor.ts")));
    return home;
  })();
}

/** Called only after killAgents has drained the run's sessions and servers. */
export function resetOpenCodeConfig() {
  configHome = undefined;
  runtimes.clear();
  liveServers.clear();
  runtimeAbort = new AbortController();
  stopping = undefined;
}

/** `provider/model` for a model name that may or may not carry its provider. */
export function qualifiedModel(model: string): string {
  return model.includes("/") ? model : `${PROVIDER}/${model}`;
}

/** Session rules are complete: children must not inherit another agent's access. */
export function reviewPermissions(tools: AgentTools) {
  const allowed = tools === "repo" ? ["read", "glob", "grep", "shell", "tilth_*"] : [];
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...allowed.map((action) => ({ action, resource: "*", effect: "allow" })),
    // The governor restricts edit to the exact output file and the write tool.
    { action: "edit", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "allow" },
  ];
}

export function openCodeSettings() {
  return {
    $schema: "https://opencode.ai/config.json",
    formatter: false,
    snapshots: false,
    share: "disabled",
    compaction: { auto: false },
    ...(Object.keys(PROVIDERS).length ? { providers: PROVIDERS } : {}),
    mcp: { servers: {
      tilth: {
        type: "local",
        command: ["tilth", "--mcp"],
        codemode: false,
        timeout: { catalog: 60000, execution: 60000 },
      },
    } },
    agents: {
      // This root records ownership; DiffLoupe schedules its children without
      // spending a model call on deciding when to delegate.
      review: {
        description: "DiffLoupe review",
        mode: "primary",
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      },
      reviewer: {
        description: "DiffLoupe review task",
        mode: "subagent",
        steps: MAX_STEPS,
        // The governor replaces this with the child's immutable system prompt.
        system: "Follow the review task supplied by DiffLoupe.",
        permissions: reviewPermissions("repo"),
      },
    },
  };
}

interface ReviewRuntime {
  server: OpenCodeRuntime;
  parentID: string;
  home: string;
  env: NodeJS.ProcessEnv;
  subscription: boolean;
}

const runtimes = new Map<boolean, Promise<ReviewRuntime>>();
let runtimeAbort = new AbortController();
let stopping: Promise<void> | undefined;
const pendingAgents = new Set<Promise<unknown>>();

function runtimeSignal(): AbortSignal {
  return SIGNAL ? AbortSignal.any([runtimeAbort.signal, SIGNAL]) : runtimeAbort.signal;
}

function checkRunning(): void {
  if (runtimeSignal().aborted) throw new CancelledError();
}

/** API credentials and subscription credentials have separate native owners. */
function reviewRuntime(subscription: boolean): Promise<ReviewRuntime> {
  checkRunning();
  const existing = runtimes.get(subscription);
  if (existing) return existing;
  const pending = (async () => {
    const home = await openCodeConfig();
    checkRunning();
    const profile = subscription ? subscriptionEnv(SUBSCRIPTION_HOME) : undefined;
    const data = profile?.XDG_DATA_HOME ?? path.join(home, "data");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...CHILD_ENV,
      PWD: SUBJECT,
      XDG_CONFIG_HOME: path.join(home, "xdg"),
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: path.join(home, subscription ? "subscription-state" : "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      OPENCODE_CONFIG_DIR: path.join(home, "config"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      REVIEW_GOVERNOR_SESSIONS: "1",
    };
    for (const key of Object.keys(env)) {
      if (["OPENCODE_DB", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CLI_CONFIG_CONTENT"].includes(key) ||
        (key.startsWith("REVIEW_GOVERNOR_") && key !== "REVIEW_GOVERNOR_SESSIONS") ||
        (subscription && key === "OPENAI_API_KEY")) delete env[key];
    }
    if (!subscription) await importCredentials(env, data);
    await ensureDir(path.join(ARTIFACTS, "logs"));
    checkRunning();
    const args = ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"];
    // One server holds the persistent profile, while all of its child sessions
    // run concurrently. The lock no longer surrounds individual agent calls.
    const command = subscription ? subscriptionCommand(SUBSCRIPTION_HOME, args, "review") : { command: "opencode", args };
    // Stop unfinished startup immediately. Once ready, normal teardown uses
    // stop() so the subscription worker can await its server before unlocking.
    const startupAbort = new AbortController();
    const cancelStartup = () => startupAbort.abort();
    runtimeAbort.signal.addEventListener("abort", cancelStartup, { once: true });
    if (runtimeAbort.signal.aborted) cancelStartup();
    let server: OpenCodeRuntime | undefined;
    try {
      server = await startOpenCodeRuntime({ ...command, cwd: SUBJECT, env,
        signal: SIGNAL ? AbortSignal.any([SIGNAL, startupAbort.signal]) : startupAbort.signal,
        logFile: path.join(ARTIFACTS, "logs", subscription ? "opencode-subscription.log" : "opencode-server.log") });
      liveServers.add(server);
      const ownedServer = server;
      void server.closed.then(() => liveServers.delete(ownedServer));
      checkRunning();
      const parentID = await server.createSession({
        title: `DiffLoupe: ${repoName || path.basename(SUBJECT)}`,
        agent: "review",
        location: { directory: SUBJECT },
        metadata: { diffloupeRun: true },
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      });
      return { server, parentID, home, env, subscription };
    } catch (error) {
      await server?.stop();
      throw error;
    } finally {
      runtimeAbort.signal.removeEventListener("abort", cancelStartup);
    }
  })();
  runtimes.set(subscription, pending);
  return pending;
}

interface AgentOptions {
  budget: number;
  outFile: string;
  tag: string;
  model?: string;
  effort?: string;
  tools?: AgentTools;
  system?: AgentSystem;
  answerKeys?: readonly string[];
}

/** Build one native child session with independent instructions and accounting. */
async function childInvocation(system: string, opts: AgentOptions): Promise<{
  spec: Invocation;
  runtime: ReviewRuntime;
  sessionID: string;
}> {
  const tools = opts.tools ?? "repo";
  const model = qualifiedModel(opts.model ?? MODEL);
  const subscription = Boolean(SUBSCRIPTION_HOME && model.startsWith("openai/"));
  const runtime = await reviewRuntime(subscription);
  checkRunning();
  const guidance = tools === "repo" ? await readText(path.join(DIR, "opencode", "tools.md")) : "";
  const usageFile = path.join(ARTIFACTS, "logs", `${opts.tag}.usage.json`);
  await ensureDir(path.dirname(usageFile));
  await removeIfPresent(usageFile);
  const slash = model.indexOf("/");
  const hash = model.indexOf("#", slash);
  const variant = hash < 0 ? (opts.effort ?? EFFORT) : model.slice(hash + 1);
  const metadata: GovernorSessionConfig = {
    version: 1,
    runID: runtime.parentID,
    tag: opts.tag,
    startedAt: Date.now(),
    budgetUsd: opts.budget,
    deadlineMs: DEADLINE_MS,
    maxSteps: MAX_STEPS,
    outFile: path.resolve(opts.outFile),
    usageFile,
    logFile: path.join(ARTIFACTS, "logs", `${opts.tag}.governor.jsonl`),
    system: guidance ? `${system}\n\n${guidance}` : system,
    tools,
    waitForTools: tools === "repo" ? "tilth_" : "",
    expectTools: [...new Set(guidance.match(/\btilth_tilth_\w+/g) ?? [])],
  };
  checkRunning();
  const sessionID = await runtime.server.createSession({
    parentID: runtime.parentID,
    agent: "reviewer",
    title: opts.tag,
    model: { providerID: model.slice(0, slash), id: model.slice(slash + 1, hash < 0 ? undefined : hash),
      ...(variant ? { variant } : {}) },
    permissions: reviewPermissions(tools),
    metadata: { diffloupe: metadata },
  });
  checkRunning();
  const env = { ...runtime.env, OPENCODE_PASSWORD: runtime.server.password };
  return {
    runtime, sessionID,
    spec: {
      command: "opencode",
      args: ["run", "--server", runtime.server.url, "--session", sessionID, "--format", "json"],
      cwd: SUBJECT,
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      unsetEnv: [],
      rawExt: "stdout.ndjson",
      parse: (stdout) => readOpenCodeUsage(usageFile) ?? sumOpenCodeStream(stdout),
      tools: (stdout) => summarizeOpenCodeTools(stdout, SUBJECT),
    },
  };
}

/**
 * The governor's running totals for one invocation, if it wrote any.
 *
 * Preferred over the stdout stream because the stream leaves out the step that
 * ends the session, which is the one that writes the answer.
 */
export function readOpenCodeUsage(file: string): ReturnType<typeof sumOpenCodeStream> | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ReturnType<typeof sumOpenCodeStream>;
  } catch {
    return undefined;
  }
}

/**
 * Why an agent delivered no output file. Each kind points somewhere different:
 * `provider` and `spawn` at credentials and tooling, the rest at what the
 * model did with a working setup.
 */
export type AgentFailure = {
  kind: "spawn" | "provider" | "invalid-json" | "wrong-path" | "exit" | "no-output";
  message: string;
};

const WRITE_TOOLS = new Set(["write", "edit", "multiedit"]);

const CONTROL_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };

/** A quote that ends a JSON string is followed by `,` `:` `}` `]` or the end of the text. */
function closesString(text: string, quoteAt: number): boolean {
  for (let i = quoteAt + 1; i < text.length; i++) {
    const c = text.charAt(i);
    if (!/\s/.test(c)) return ",:}]".includes(c);
  }
  return true;
}

/**
 * Parses an agent's output file. Some models put raw tabs and newlines inside
 * string values (usually `suggested_code` copied from a tab-indented file), or
 * leave a double quote in prose unescaped; JSON.parse rejects both. Those are
 * escaped and the parse retried.
 */
export function parseAgentJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    let out = "";
    let inString = false;
    let escaped = false;
    let changed = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') {
          if (closesString(text, i)) inString = false;
          else {
            out += '\\"';
            changed = true;
            continue;
          }
        } else if (c < " ") {
          out += CONTROL_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
          changed = true;
          continue;
        }
      } else if (c === '"') inString = true;
      out += c;
    }
    if (!changed) throw error;
    try {
      return JSON.parse(out);
    } catch {
      throw error;
    }
  }
}

/** Works out from the stream and the exit status why `outFile` is missing or unreadable. */
export function diagnoseMissingOutput(o: {
  outFile: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  /** Set when the file exists but did not parse. */
  parseError?: string | undefined;
}): AgentFailure {
  if (o.parseError !== undefined) {
    return { kind: "invalid-json", message: `wrote ${o.outFile}, but it is not valid JSON (${o.parseError})` };
  }
  const providerErrors: string[] = [];
  const writes: string[] = [];
  for (const line of o.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: {
      type?: string;
      error?: { type?: string; name?: string; message?: string; data?: { message?: string } };
      part?: { type?: string; tool?: string; state?: { status?: string; input?: { path?: unknown; filePath?: unknown } } };
    };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "error" && event.error) {
      const e = event.error;
      const label = e.type ?? e.name ?? "error";
      const message = e.message ?? e.data?.message;
      providerErrors.push(message ? `${label}: ${message}` : label);
      continue;
    }
    const part = event.part;
    if (event.type !== "tool_use" || part?.type !== "tool" || !WRITE_TOOLS.has(part.tool ?? "")) continue;
    if (part.state?.status !== "completed") continue;
    const target = part.state.input?.path ?? part.state.input?.filePath;
    if (typeof target === "string") writes.push(target);
  }
  if (providerErrors.length) {
    return { kind: "provider", message: `the model provider returned an error (${providerErrors[0]})` };
  }
  const elsewhere = writes.filter((p) => path.resolve(o.cwd, p) !== path.resolve(o.cwd, o.outFile));
  if (elsewhere.length) {
    return { kind: "wrong-path", message: `wrote its output to ${elsewhere.at(-1)} instead of ${o.outFile}` };
  }
  if (o.exitCode !== 0) {
    const tail = o.stderr.trim().split("\n").at(-1)?.slice(0, 300);
    return { kind: "exit", message: `exited with code ${o.exitCode} without writing its output${tail ? `: ${tail}` : ""}` };
  }
  return { kind: "no-output", message: "finished without writing its output file" };
}

/** The text of the agent's last non-empty reply in an `opencode run --format json` stream. */
export function lastReplyText(stdout: string): string | undefined {
  let last: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: { part?: { type?: string; text?: unknown } };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const text = event.part?.type === "text" ? event.part.text : undefined;
    if (typeof text === "string" && text.trim()) last = text;
  }
  return last;
}

/**
 * The answer an agent put in its final reply instead of writing its output
 * file. Some models (GLM-5.3-Flash most often) finish with the JSON in a fenced
 * block and never call the write tool. Tries the fenced blocks, last first, then
 * the span from the first `{` to the last `}`. A candidate counts only when it is
 * an object with at least one of `keys`, so a stray code snippet in a prose
 * reply is not mistaken for an empty answer.
 */
export function answerFromText(text: string, keys: readonly string[]): unknown {
  const candidates = [...text.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "").reverse();
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open !== -1 && close > open) candidates.push(text.slice(open, close + 1));
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = parseAgentJson(candidate.trim());
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    if (keys.length === 0 || keys.some((k) => k in value)) return value;
  }
  return undefined;
}

/** Each scheduled task is a native child session on the run's owned server. */
export function agent(prompt: string, opts: AgentOptions) {
  const pending = invokeAgent(prompt, opts);
  pendingAgents.add(pending);
  void pending.finally(() => pendingAgents.delete(pending)).catch(() => {});
  return pending;
}

async function invokeAgent(prompt: string, opts: AgentOptions) {
  checkRunning();
  installExitHook();
  let child: Awaited<ReturnType<typeof childInvocation>> | undefined;
  try {
    const system = opts.system?.text ?? (await readText(path.join(DIR, "system.md"))).replaceAll("{{repo}}", repoName);
    child = await childInvocation(system, opts);
    const { spec, runtime, sessionID } = child;
    checkRunning();
    const result = await runAgent(prompt, opts, spec, spec.env);
    checkRunning();
    // An attached client's failure must not leave a paid session running.
    if (result.exitCode !== 0) await runtime.server.interrupt(sessionID);
    return result;
  } catch (error) {
    await child?.runtime.server.interrupt(child.sessionID).catch(() => {});
    if (runtimeSignal().aborted) throw new CancelledError();
    throw error;
  }
}

/** Imports saved API credentials once, before their review server starts. */
async function importCredentials(env: Record<string, string | undefined>, dataDir: string | undefined): Promise<void> {
  if (!AUTH_IMPORT || !dataDir) return;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const res = await run("opencode", ["auth", "import", "--standalone"], {
    env: env as NodeJS.ProcessEnv,
    cwd: SUBJECT,
    input: AUTH_IMPORT,
    allowFail: true,
    timeoutMs: 60_000,
    signal: runtimeSignal(),
  });
  if (res.code !== 0) {
    throw new Error(`opencode auth import failed (exit ${res.code}). Run diffloupe doctor to check credentials.`);
  }
}

async function runAgent(
  prompt: string,
  opts: { outFile: string; tag: string; answerKeys?: readonly string[] },
  spec: Invocation,
  env: Record<string, string | undefined>,
) {
  if (SIGNAL?.aborted) throw new CancelledError();
  installExitHook();
  const started = Date.now();
  const { stdout, stderr, exitCode } = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>((resolve, reject) => {
    // The prompt goes in on stdin, not argv, on both runners: it carries the
    // diff, and Linux caps a single argument at 128 KiB, which a few thousand
    // changed lines will exceed.
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let markClosed = () => {};
    liveAgents.set(child, new Promise<void>((r) => (markClosed = r)));
    const forget = () => {
      liveAgents.delete(child);
      markClosed();
    };
    // A child can close stdin while it is still running. Wait for close before
    // interrupting its native session and releasing resources.
    let inputError: Error | undefined;
    child.stdin.on("error", (error) => {
      inputError = error;
      signalGroup(child, "SIGKILL");
    });
    child.stdin.end(prompt);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      forget();
      reject(e);
    });
    child.on("close", (code, sig) => {
      forget();
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        // Preserve OpenCode's diagnostic (for example, a changed login) when
        // it exits before reading the whole prompt instead of masking it with EPIPE.
        exitCode: code || (sig ? 128 : inputError ? 1 : 0),
      });
    });
  });
  const wallMs = Date.now() - started;
  await writeText(path.join(ARTIFACTS, "logs", `${opts.tag}.stderr.log`), stderr);
  await writeText(path.join(ARTIFACTS, "raw", `${opts.tag}.${spec.rawExt}`), stdout);
  const meta = spec.parse(stdout);
  const tools = spec.tools?.(stdout);
  let payload: unknown = null;
  let failure: AgentFailure | undefined;
  try {
    payload = parseAgentJson(await readText(opts.outFile));
  } catch (error) {
    const parseError = (await exists(opts.outFile))
      ? (error instanceof Error ? error.message : String(error))
      : undefined;
    failure = diagnoseMissingOutput({ outFile: opts.outFile, stdout, stderr, exitCode, cwd: spec.cwd, parseError });
  }
  let deliveredAs: "text" | undefined;
  if (failure?.kind === "no-output") {
    const reply = lastReplyText(stdout);
    const answer = reply === undefined || !opts.answerKeys?.length ? undefined : answerFromText(reply, opts.answerKeys);
    if (answer !== undefined) {
      payload = answer;
      failure = undefined;
      deliveredAs = "text";
      // Written out so a rerun that reuses this call's output finds it where it expects.
      await writeText(opts.outFile, `${JSON.stringify(answer, null, 2)}\n`);
      console.error(`  ${opts.tag}: no output file; read the answer from the final reply`);
    }
  }
  return { wallMs, exitCode, ...meta, tools, payload, failure, ...(deliveredAs ? { deliveredAs } : {}) };
}
