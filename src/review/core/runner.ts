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
  repoName,
} from "./config.ts";
import { run } from "./lib/proc.ts";

// ---------------------------------------------------------------- cancellation

export class CancelledError extends Error {
  override name = "CancelledError";
  constructor() {
    super("review cancelled");
  }
}

/**
 * Live agent processes. Each is spawned detached, so it leads its own process
 * group: OpenCode starts `tilth --mcp` and shell tools as children, and killing
 * only the direct child would leave those running inside the worktree. The
 * flip side is that a terminal's Ctrl+C no longer reaches them, so whoever
 * handles SIGINT has to call `killAgents()`.
 */
const liveAgents = new Map<ChildProcess, Promise<void>>();
let exitHookInstalled = false;

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
}

/**
 * SIGTERM to every live agent's process group, then SIGKILL after `graceMs`
 * for any that have not closed. Resolves when all have closed.
 */
export async function killAgents(graceMs = 5000): Promise<void> {
  const pending = [...liveAgents];
  if (!pending.length) return;
  for (const [child] of pending) signalGroup(child, "SIGTERM");
  const timer = setTimeout(() => {
    for (const [child] of pending) if (liveAgents.has(child)) signalGroup(child, "SIGKILL");
  }, graceMs);
  await Promise.all(pending.map(([, closed]) => closed));
  clearTimeout(timer);
}

export function liveAgentCount(): number {
  return liveAgents.size;
}

// ---------------------------------------------------------------- agent

/**
 * How to spawn one agent invocation, and how to read its accounting back.
 *
 * The two runners disagree on nearly everything mechanical — flags, where the
 * system prompt lives, how tools are restricted, whether spend is capped for
 * you, what shape the metadata comes back in — so each builds one of these and
 * `agent()` stays indifferent to which it got.
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
 * A system prompt other than the reviewer contract, for a call that is not a
 * review. `name` picks its config directory, so it must be unique per prompt.
 */
export interface AgentSystem {
  name: string;
  text: string;
}

const openCodeHomes = new Map<string, { home: Promise<string>; key: string }>();

/**
 * Write the configuration directory the OpenCode runner reads, once per run.
 *
 * Every invocation in a run wants byte-identical configuration, and OpenCode
 * installs its plugin package into whichever directory it is pointed at the
 * first time it sees one. Given a directory per invocation that install ran
 * five times at about five seconds each; shared, it runs once. The result is
 * memoised rather than merely written to a fixed path because slices run
 * concurrently, and one install racing five others in the same directory is not
 * something to find out about during a paid review.
 *
 * Memoising a prompt is worth a guard, though. If a caller ever wanted
 * different instructions it would silently get the first caller's, and the
 * symptom — a reviewer following a prompt nobody sent it — would be very hard
 * to read back from the output.
 */
export function openCodeConfig(
  system: string,
  guidance: string,
  tools: AgentTools = "repo",
  name?: string,
): Promise<string> {
  const key = `${system}\u0000${guidance}`;
  const dir = `${tools === "repo" ? "shared" : "no-tools"}${name ? `-${name}` : ""}`;
  const memo = openCodeHomes.get(dir);
  if (memo && memo.key !== key) {
    throw new Error("openCodeConfig called with a different prompt after the config was written");
  }
  if (memo) return memo.home;
  const home = (async () => {
    const home = path.join(OUT, "oc", dir);
    const configDir = path.join(home, "config");
    await writeJson(path.join(configDir, "opencode.json"), openCodeSettings(system, guidance, tools));
    await writeText(
      path.join(configDir, "plugin", "governor.ts"),
      await readText(path.join(DIR, "opencode", "governor.ts")),
    );
    return home;
  })();
  openCodeHomes.set(dir, { home, key });
  return home;
}

/**
 * Forget the memoised configuration. Called when a run ends, because a
 * long-lived server's next run can have a different repository name in its
 * prompt, a different scratch directory, or different providers.
 */
export function resetOpenCodeConfig() {
  openCodeHomes.clear();
}

/** `provider/model` for a model name that may or may not carry its provider. */
export function qualifiedModel(model: string): string {
  return model.includes("/") ? model : `${PROVIDER}/${model}`;
}

export function openCodeSettings(system: string, guidance: string, tools: AgentTools = "repo") {
  const allowed = tools === "repo" ? ["read", "glob", "grep", "shell", "tilth_*"] : [];
  return {
    $schema: "https://opencode.ai/config.json",
    // A formatter would rewrite the findings file after the agent wrote it.
    formatter: false,
    snapshots: false,
    share: "disabled",
    // A compaction is an unbudgeted model call that rewrites the reviewer's
    // context in the middle of an investigation. The step cap ends a slice long
    // before its context fills, so there is nothing for it to rescue.
    compaction: { auto: false },
    // Custom providers and provider settings from the user's own config, so a
    // model defined there resolves here too.
    ...(Object.keys(PROVIDERS).length ? { providers: PROVIDERS } : {}),
    mcp: {
      servers: tools === "none" ? {} : {
        // Without this the reviewer has no structural reader, and it shows:
        // given only shell tools it sampled eighty lines out of the file the PR
        // changed and missed every defect in the rest of it.
        //
        // `codemode: false` exposes the tools directly as `tilth_tilth_search`
        // and so on, which is what tools.md and the governor's tips name.
        // Under Code Mode they would only be reachable through `execute`.
        tilth: {
          type: "local",
          command: ["tilth", "--mcp"],
          codemode: false,
          timeout: { catalog: 60000, execution: 60000 },
        },
      },
    },
    agents: {
      reviewer: {
        description: "code review pipeline",
        mode: "primary",
        steps: MAX_STEPS,
        // Replaces the built-in coding-agent prompt outright rather than adding
        // to it, which is what `--system-prompt` did on the other runner. That
        // includes the built-in tool guidance, which is why ours is appended
        // here: without it the reviewer gets no instruction on what tools exist
        // and falls back to shelling out for everything.
        system: guidance ? `${system}\n\n${guidance}` : system,
        // Ordered, last match wins. Denying everything first turns off every
        // tool this list does not name, including ones a later OpenCode adds:
        // subagents, questions, skills, web access and Code Mode.
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          ...allowed.map((action) => ({
            action,
            resource: "*",
            effect: "allow",
          })),
          // One action gates write, edit and patch together, and the config is
          // shared by every call while the output path is per call. The
          // governor's checkWriteTarget narrows this to the call's output file.
          { action: "edit", resource: "*", effect: "allow" },
          // Findings and artifacts both land outside the checkout under review.
          { action: "external_directory", resource: "*", effect: "allow" },
        ],
      },
    },
  };
}

/**
 * Spawn plan for the OpenCode runner.
 *
 * Everything `claude` took as a flag is configuration here, so this points the
 * binary at a config directory we wrote. That directory is also the isolation:
 * run unconfigured, OpenCode loads the developer's own config, skills and
 * plugins, and one such plugin injected three and a half thousand tokens of
 * unrelated repository map into the prompt. Beyond the waste, prompts here are
 * built from attacker-controlled pull request text, and third-party prose has
 * no business in them. Isolated, the same call read a third of the input
 * tokens.
 *
 * `--pure` looks like the way to get that isolation and is not: it suppresses
 * our own governor plugin along with everyone else's, which removes the spend
 * cap. The relocated config and data directories do the job instead.
 *
 * `--standalone` gives each invocation a private server. Without it every
 * invocation attaches to one shared background service, which would run all
 * of them under whichever configuration started it first.
 */
export async function openCodeInvocation(
  system: string,
  opts: {
    budget: number;
    model: string;
    effort: string;
    tag: string;
    outFile: string;
    tools?: AgentTools;
    /** Names a system prompt other than the reviewer contract; see `AgentSystem`. */
    systemName?: string | undefined;
  },
): Promise<Invocation> {
  const tools = opts.tools ?? "repo";
  const guidance = tools === "repo" ? await readText(path.join(DIR, "opencode", "tools.md")) : "";
  const home = await openCodeConfig(system, guidance, tools, opts.systemName);
  const configDir = path.join(home, "config");
  const usageFile = path.join(ARTIFACTS, "logs", `${opts.tag}.usage.json`);
  await ensureDir(path.dirname(usageFile));
  await removeIfPresent(usageFile);

  // Thinking is a property of the model variant in this runner: `#medium` and
  // so on, whose meaning the model catalog defines.
  const variant = opts.effort;
  const model = qualifiedModel(opts.model);
  const args = [
    "run",
    "--standalone",
    "--format", "json",
    "--agent", "reviewer",
    "--model", variant && !model.includes("#") ? `${model}#${variant}` : model,
    // Naming the session stops a second, unbudgeted model call being made to
    // invent a title for it.
    "--title", opts.tag,
  ];

  return {
    command: "opencode",
    args,
    cwd: SUBJECT,
    env: {
      // OpenCode reads $PWD rather than the process's actual working directory
      // when it decides which project it is looking at. The inherited value is
      // the shell that launched the pipeline, so without this every review reads
      // the checkout the pipeline is running from instead of the PR's code, and
      // reports on the wrong source while being shown the right diff. It is set
      // from the same field the child is spawned in so the two cannot disagree.
      PWD: SUBJECT,
      XDG_CONFIG_HOME: path.join(home, "xdg"),
      // The configuration is shared but the data directory cannot be, because
      // it holds a SQLite session database and invocations run concurrently:
      // the coordinator and the walkthrough always overlap, and slices run six
      // at a time. Sharing it cost a whole coordinator phase to "database is
      // locked", which the pipeline absorbed as a silent fall back to
      // deterministic merging. A private directory costs about a second of
      // startup; the install that made sharing worth doing is in the config
      // directory, which is still shared.
      XDG_DATA_HOME: path.join(home, "data", opts.tag),
      XDG_STATE_HOME: path.join(home, "state", opts.tag),
      XDG_CACHE_HOME: path.join(home, "cache"),
      OPENCODE_CONFIG_DIR: configDir,
      // Also stops AGENTS.md files in the checkout reaching the prompt. Those
      // come from the pull request under review.
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      REVIEW_GOVERNOR_BUDGET_USD: String(opts.budget),
      REVIEW_GOVERNOR_DEADLINE_MS: String(DEADLINE_MS),
      REVIEW_GOVERNOR_MAX_STEPS: String(MAX_STEPS),
      REVIEW_GOVERNOR_OUT_FILE: opts.outFile,
      REVIEW_GOVERNOR_LOG: path.join(ARTIFACTS, "logs", `${opts.tag}.governor.jsonl`),
      REVIEW_GOVERNOR_USAGE_FILE: usageFile,
      // MCP servers connect in the background, and without the wait the first
      // turns are taken with no tilth tools on offer.
      REVIEW_GOVERNOR_WAIT_FOR_TOOLS: tools === "repo" ? "tilth_" : "",
      // tilth builds that report the same version expose different tools, and
      // guidance pointing at a missing one is advice the model cannot follow.
      REVIEW_GOVERNOR_EXPECT_TOOLS: [...new Set(guidance.match(/\btilth_tilth_\w+/g) ?? [])].join(","),
    },
    unsetEnv: ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CLI_CONFIG_CONTENT"],
    rawExt: "stdout.ndjson",
    parse: (stdout) => readOpenCodeUsage(usageFile) ?? sumOpenCodeStream(stdout),
    tools: (stdout) => summarizeOpenCodeTools(stdout, SUBJECT),
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

export async function agent(
  prompt: string,
  opts: {
    budget: number;
    outFile: string;
    tag: string;
    model?: string;
    effort?: string;
    tools?: AgentTools;
    /** Replaces the reviewer contract in `system.md`, for a call that does not review. */
    system?: AgentSystem;
  },
) {
  if (SIGNAL?.aborted) throw new CancelledError();
  const system = opts.system?.text ?? (await readText(path.join(DIR, "system.md"))).replaceAll("{{repo}}", repoName);
  const model = opts.model ?? MODEL;
  const effort = opts.effort ?? EFFORT;
  const spec: Invocation = await openCodeInvocation(system, { ...opts, model, effort, systemName: opts.system?.name });
  const env: Record<string, string | undefined> = { ...process.env, ...CHILD_ENV, ...spec.env };
  for (const key of spec.unsetEnv) delete env[key];
  const privateDirs = [spec.env.XDG_DATA_HOME, spec.env.XDG_STATE_HOME].filter((d) => d !== undefined);
  try {
    return await runAgent(prompt, opts, spec, env);
  } finally {
    // The private data directory holds the session database and any imported
    // API key. Nothing reads it after the process exits: usage and governor
    // logs are written under ARTIFACTS.
    if (process.env.DIFFLOUPE_KEEP_SCRATCH !== "1") {
      await Promise.all(privateDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
    }
  }
}

/** Imports the run's saved credentials into a call's fresh data directory. */
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
  });
  if (res.code !== 0) {
    throw new Error(`opencode auth import failed (exit ${res.code}): ${res.stderr.trim().slice(0, 500)}`);
  }
}

async function runAgent(
  prompt: string,
  opts: { outFile: string; tag: string },
  spec: Invocation,
  env: Record<string, string | undefined>,
) {
  if (SIGNAL?.aborted) throw new CancelledError();
  await importCredentials(env, spec.env.XDG_DATA_HOME);
  if (SIGNAL?.aborted) throw new CancelledError();
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", killAgentsNow);
  }
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
    child.stdin.on("error", reject);
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
        exitCode: code ?? (sig ? 128 : 0),
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
  return { wallMs, exitCode, ...meta, tools, payload, failure };
}
