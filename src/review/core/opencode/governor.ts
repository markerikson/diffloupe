/**
 * Spend governor for the OpenCode runner.
 *
 * The `claude` binary took `--max-budget-usd` and stopped itself. OpenCode has
 * no equivalent, so the cap is enforced from inside the session instead. This
 * file is copied into the runner's config directory by pipeline.ts and loaded by
 * OpenCode as a plugin; it is not part of the pipeline's own module graph, and
 * the types below are hand-written against the V2 plugin API rather than
 * imported, because `@opencode/plugin` is not a dependency of this repository.
 * `Plugin.define` is the identity function, so a plain `{ id, setup }` default
 * export is the same thing.
 *
 * REVIEW_GOVERNOR_SESSIONS=1 selects shared-server mode: metadata.diffloupe
 * supplies immutable configuration per session, validated before any work or
 * accounting. The legacy environment configuration remains for standalone runs.
 *
 * Stopping by killing the process was the obvious approach and is the wrong one:
 * a slice delivers its findings by writing a JSON file as its last act, so a
 * kill throws away everything the turn had already established. Every stage here
 * is chosen to leave that write reachable.
 *
 * Two limits, cost and elapsed time, drive three stages. Whichever is closer to
 * being reached is the one in force, so a limit that is not configured simply
 * never becomes the binding one:
 *
 *  - At `NUDGE_AT` of the limit, a wrap-up notice is appended to the result of
 *    each tool call. The agent is still free to work; it just knows the clock is
 *    running and can choose to land.
 *  - At the limit, every tool except the file write is refused. The refusal is
 *    delivered to the model as a tool error, so it reads as an instruction
 *    rather than a malfunction, and the one remaining action is the one that
 *    delivers findings. Once the findings file exists the write is refused too,
 *    which leaves no tool to call and ends the session on its own.
 *  - At `ABORT_AT` of the limit the session is interrupted outright, and only
 *    while the findings file is still missing. Interrupting is confined to the
 *    case where there was nothing to lose: an agent that keeps retrying refused
 *    tools instead of writing. `steps` in the agent config is the backstop if
 *    even that does not settle it.
 *
 * Time is a limit and not just a proxy for cost because on a cheap model the two
 * come apart completely. Measured on one slice of PR #13202: the same unit that
 * cost Opus 5 $1.58 in 22 steps cost GLM-5.3-Flash $0.10 in 46 steps, and was
 * still going at thirteen minutes. Against a $3 budget every cost stage here
 * stayed inert for the whole run while the thing that needed bounding ran away.
 * Per-step latency barely differs between the two models; step count is what
 * differs, and on a model priced thirty times lower only the clock notices.
 *
 * Every message the governor sends to the model rides on a tool result or a tool
 * error, and never on the system prompt. The system prompt is the prefix of the
 * prompt cache, so appending to it invalidates the cache and the whole context
 * is re-sent at full price. Measured on one slice of PR #13202: injecting the
 * notice into the system prompt dropped cache reads from 85k to 6k, rewrote 83k
 * of cache, and took the per-step cost from $0.05 to $0.54. A governor that
 * makes overspending ten times more expensive is worse than no governor. Tool
 * results append after the cached prefix and cost nothing extra.
 *
 * The same plugin also governs shell use, for the same reason and by the same
 * mechanism. Cost on this runner tracks step count almost exactly, so an agent
 * that reads the codebase in `sed` fragments and searches it with `git grep`
 * costs several times what one using the structured tools costs, and reviews it
 * worse. The tool guidance says so and is partly ignored, so the rules below say
 * it again at the point of use.
 *
 * Two jobs here are not governing at all, and live in this plugin because it is
 * the only code of ours inside the OpenCode process:
 *
 *  - Accounting. `opencode run --format json` leaves the final step of a session
 *    out of its stream — the text-only step that ends the turn never gets a
 *    `step_finish` line — so a total summed from stdout is short by one step on
 *    every call. The step events this plugin receives include that step, so the
 *    governor writes the authoritative totals to `REVIEW_GOVERNOR_USAGE_FILE`.
 *  - Waiting for tilth. MCP servers connect in the background, and a session
 *    that starts first gets its first model requests without the MCP tools in
 *    the tool list. A reviewer whose first two steps are offered only the shell
 *    and the built-in readers starts the habit the rules below exist to break.
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Fraction of the binding limit at which tool results carry the wrap-up notice. */
const NUDGE_AT = 0.75;
/** Multiple of the binding limit at which an agent with no findings file is interrupted. */
const ABORT_AT = 2;
/** Steps kept back below OpenCode's `steps` cap for writing the findings file. */
const STEP_RESERVE = 5;
/**
 * Ceiling on any single shell command, in milliseconds.
 *
 * OpenCode's own shell timeout defaults to 120 seconds, and the model may ask for
 * more or for none at all, so the cap is applied here. Measured on one slice of
 * PR #13202: a filesystem-wide `find` burned 111 seconds and returned nothing, a
 * fifth of that run's wall time in one call. Nothing a reviewer legitimately
 * runs takes twenty seconds — the commands that would are builds and tests, and
 * the review checkout has no dependencies installed to run them with. Unlike the
 * pattern rules below, this bounds the damage from commands nobody anticipated.
 */
const MAX_SHELL_MS = 20_000;
/** Times a warned shell pattern is tipped before it is refused outright. */
const WARN_LIMIT = 3;
/** Longest the first model request is held back waiting for the MCP tools to register. */
const TOOL_WAIT_MS = 30_000;

/**
 * A shell pattern the reviewer should not be using, and what to use instead.
 *
 * `match` and `except` are tested against the command at the head of a shell
 * segment, never against a pipe target: `... | grep foo` is filtering another
 * command's output, which no tool here replaces.
 */
type ShellRule = {
  /** Short identifier, used in counts, log lines and test names. */
  name: string;
  match: RegExp;
  /** If this also matches, the segment passes silently. */
  except?: RegExp;
  /** One sentence, delivered to the model verbatim. */
  tip: string;
};

const SHELL_RULES: ShellRule[] = [
  {
    name: "bash-search",
    // `git grep` is included deliberately: it was eleven of fourteen shell
    // calls on one measured slice, and it is exactly what tilth_tilth_search
    // does better.
    match: /^(?:rg|grep|egrep|fgrep|ag|git\s+grep)\b/,
    // Counting matches and listing matching files are answers the structured
    // search does not give as directly, so those flags pass.
    except: /(?:^|\s)-(?:c|l|-count|-files-with-matches|-files)\b/,
    tip: "use tilth_tilth_search to search the code (kind:content for text, kind:regex for patterns, kind:symbol for definitions, kind:callers for call sites) — it ranks results and returns definitions first. Filtering another command's output with grep is fine.",
  },
  {
    name: "bash-find",
    match: /^(?:find|fd)\b/,
    // find used to run an action rather than to list files.
    except: /\s-(?:exec|execdir|ok|okdir|delete)\b/,
    tip: "use tilth_tilth_files with a glob pattern to locate files.",
  },
  {
    name: "bash-read",
    // Reading a file through the shell: cat with a file argument, or a slice
    // taken with sed/head/tail. Excludes heredocs, stdin, and redirects, which
    // are writes rather than reads.
    match: /^(?:cat\s+(?!<<|-\s|-$)\S|sed\s+-n\b|head\b|tail\b)/,
    except: /[<>]/,
    tip: "use tilth_tilth_read instead — `mode: \"full\"` for a file under review, `paths` to read several at once, `sections` for ranges of a file you have already read. A review assembled from line-range fragments misses the defects that span a file.",
  },
];

/**
 * A built-in tool that duplicates a tilth tool, and what to use instead.
 *
 * The shell rules above only ever see the shell tool's `command`, so they are
 * blind to OpenCode's own search tools. On one measured slice a model refused
 * its fourth `rg` switched to the built-in `grep` and used it six more times; on
 * another it skipped the shell entirely and went straight to `grep` nine times,
 * drawing no rule at all. Steering away from the shell while leaving an
 * unpoliced tool that does the same thing just moves the traffic.
 */
type BuiltinRule = {
  name: string;
  tip: string;
  /**
   * Tipped every time but never refused. Reading a file is the core activity of
   * a review, and a reviewer refused the ability to read has no move left that
   * gets the job done.
   */
  adviseOnly?: boolean;
};

const BUILTIN_RULES: Record<string, BuiltinRule> = {
  grep: {
    name: "builtin-search",
    tip: "use tilth_tilth_search rather than the plain grep tool — it ranks results, returns definitions before usages, and takes kind:content, kind:regex, kind:symbol and kind:callers. Comma-separate up to five symbols to answer several questions in one call.",
  },
  glob: {
    name: "builtin-files",
    tip: "use tilth_tilth_files to locate files by pattern.",
  },
  read: {
    name: "builtin-read",
    adviseOnly: true,
    tip: "prefer tilth_tilth_read — it takes `paths` to read several files in one call and `mode: \"full\"` to force whole-file content for anything under review.",
  },
};

/** Classify a built-in tool call: warned, or fine. */
const checkBuiltinTool = (tool: string): { rule: string; tip: string; adviseOnly: boolean } | null => {
  const hit = BUILTIN_RULES[tool];
  return hit ? { rule: hit.name, tip: hit.tip, adviseOnly: hit.adviseOnly === true } : null;
};

/**
 * Shell commands refused on sight, with no warning ladder.
 *
 * Reserved for commands that cannot produce a useful answer, so there is no
 * cost to refusing the first one. A filesystem-wide `find` qualifies: the
 * review checkout is a bare git worktree with no dependencies installed, so
 * searching outside it finds nothing that is under review, and the one measured
 * instance spent 111 seconds to return zero bytes.
 */
const isFilesystemWideFind = (core: string): boolean => {
  if (!/^(?:find|fd)\b/.test(core)) return false;
  const cwd = process.cwd();
  return core
    .split(/\s+/)
    .slice(1)
    .some((tok) => {
      const t = tok.replace(/^['"]/, "").replace(/['"]$/, "");
      if (t.startsWith("~") || t.startsWith("$HOME")) return true;
      if (!t.startsWith("/")) return false;
      return t !== cwd && !t.startsWith(cwd + "/");
    });
};

/**
 * Split a command line into segments and mark each with the separator that
 * introduced it, so pipe targets can be skipped. Quoted regions are stepped
 * over, because a separator inside a search pattern is not a separator.
 */
const splitSegments = (cmd: string): { sep: string; text: string }[] => {
  const out: { sep: string; text: string }[] = [];
  let sep = "";
  let start = 0;
  let quote = "";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    const background = c === "&" && cmd[i - 1] !== ">" && cmd[i - 1] !== "|" && cmd[i + 1] !== ">";
    const found =
      two === "&&" || two === "||" ? two : c === ";" || c === "|" || c === "\n" || background ? c : "";
    if (!found) continue;
    out.push({ sep, text: cmd.slice(start, i) });
    sep = found;
    i += found.length - 1;
    start = i + 1;
  }
  out.push({ sep, text: cmd.slice(start) });
  return out;
};

/** Strip leading environment assignments and wrappers that hide the real command. */
const commandCore = (segment: string): string =>
  segment
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, "")
    .replace(/^(?:timeout|env|xargs)(?:\s+(?:-\S+|\d[\w.]*|[A-Z][A-Z0-9_]*|[A-Za-z_]\w*=\S*|\{\}))*\s+/, "")
    .replace(/^(?:command|nohup)\s+/, "")
    .trim();

/**
 * Log-shaped files, including rotated ones. Reading a log through the shell is
 * analysis, not code reading, and the structured tools are not a better fit.
 *
 * Deliberately narrower than the desktop version of these rules, which also
 * exempts anything under `/tmp`. The review checkout itself lives in `/tmp`, so
 * that exemption here would switch every rule off for every file under review.
 */
const isLogLikeTarget = (target: string): boolean =>
  /\.(?:log|out|err|jsonl|ndjson|csv|tsv)(?:\.\d+)?$/i.test(
    target.replace(/^['"]/, "").replace(/['"]$/, ""),
  );

/**
 * File-argument tokens of a command: skip the command name, flags, quoted
 * tokens (search patterns) and bare words with neither a slash nor an
 * extension. A heuristic — a miss only means the rule fires as it would have.
 */
const fileArgs = (core: string): string[] =>
  core
    .split(/\s+/)
    .slice(1)
    .filter(
      (tok) =>
        tok.length > 0 &&
        !tok.startsWith("-") &&
        !/^['"]/.test(tok) &&
        (tok.includes("/") || /\.[A-Za-z0-9]+$/.test(tok)),
    );

/**
 * Commands that reach the network, refused on sight wherever they appear in a
 * command line, pipe targets included.
 *
 * Nothing a review needs is on the network: the pipeline gathers the PR's
 * description and prior comments before any agent starts. What is out there is
 * the rest of the PR thread, which carries the author's arguments and is how a
 * reviewer gets argued out of a finding without judging the code, and on a CI
 * runner the job's token is in the agent's environment. This catches the
 * commands, not every way to open a socket, so CI should restrict outbound
 * network as well. The web tools are denied in the agent config.
 */
const NETWORK_COMMAND = new RegExp(
  [
    /^(?:curl|wget|nc|ncat|netcat|telnet|ssh|scp|sftp|ftp|http|https|xh)\b/.source,
    /^gh\s+(?:api|pr|issue|repo|run|search|browse|release|gist|workflow|auth)\b/.source,
    /^git\s+(?:-[Cc]\s+\S+\s+)*(?:fetch|pull|push|clone|ls-remote|remote\s+update|submodule\s+update)\b/.source,
  ].join("|"),
);
/** Interpreters whose inline code is checked for network calls. */
const INTERPRETER = /^(?:node|bun|deno|python[0-9.]*|ruby|perl|php)\b/;
const NETWORK_CODE =
  /\bfetch\s*\(|\bhttps?\.(?:get|request)\b|['"](?:node:)?https?['"]|\burllib\b|\brequests\.|\bhttp\.client\b|\bsocket\b|Net::HTTP|LWP::|XMLHttpRequest|WebSocket|\b(?:Bun|Deno)\.connect\b/;

/** Commands nested inside a segment: `$(...)`, backticks, `sh -c '...'` and `eval '...'`. */
const nestedCommands = (text: string): string[] =>
  [
    /\$\((?<inner>[^()]*)\)/g,
    /`(?<inner>[^`]*)`/g,
    /\b(?:ba|z|da)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c\s+(['"])(?<inner>.*?)\1/g,
    /\beval\s+(['"])(?<inner>.*?)\1/g,
  ].flatMap((re) => [...text.matchAll(re)].map((m) => m.groups?.inner ?? ""));

const reachesNetwork = (cmd: string, depth = 0): boolean => {
  if (depth > 3) return false;
  for (const segment of splitSegments(cmd)) {
    let core = commandCore(segment.text);
    for (let prev = ""; prev !== core; ) {
      prev = core;
      core = commandCore(
        core
          .replace(/^[({!&]\s*/, "")
          .replace(/^(?:sudo|exec|nice)\s+/, "")
          .replace(/^[^\s'"]*\//, ""),
      );
    }
    if (NETWORK_COMMAND.test(core)) return true;
    if (INTERPRETER.test(core) && NETWORK_CODE.test(core)) return true;
    if (nestedCommands(segment.text).some((inner) => reachesNetwork(inner, depth + 1))) return true;
  }
  return false;
};

/** Classify a shell command: refused outright, warned, or fine. */
const checkShellCommand = (cmd: string): { rule: string; tip: string; deny: boolean } | null => {
  if (reachesNetwork(cmd))
    return {
      rule: "network",
      deny: true,
      tip: "reach the network during a review. Everything the review needs is in the checkout and in your instructions; judge the code as it stands.",
    };

  for (const segment of splitSegments(cmd)) {
    if (segment.sep === "|") continue;
    const core = commandCore(segment.text);

    if (isFilesystemWideFind(core))
      return {
        rule: "find-outside-checkout",
        deny: true,
        tip: "search outside the review checkout, which is a bare worktree with no dependencies installed and nothing else of yours on disk. Stay inside the checkout and use tilth_tilth_files.",
      };

    for (const rule of SHELL_RULES) {
      if (rule.except?.test(core)) continue;
      if (!rule.match.test(core)) continue;
      const args = fileArgs(core);
      if (args.length > 0 && args.every(isLogLikeTarget)) continue;
      return { rule: rule.name, tip: rule.tip, deny: false };
    }
  }
  return null;
};

/** File-writing tools whose input names one target file. */
const PATH_WRITE_TOOLS = new Set(["write", "edit", "multiedit"]);
/** File-writing tools whose targets are buried in a patch body. */
const PATCH_WRITE_TOOLS = new Set(["apply_patch", "patch"]);

/**
 * Refuse any file write except to the output file.
 *
 * A reviewer has exactly one thing to write, and the pipeline only reads it
 * from the one path the prompt names. Measured on one run: both slices wrote
 * their findings to a path with the 12-character head SHA of their working
 * directory in place of the run tag's shorter one, and the run failed with
 * $1.52 of finished review sitting in files nothing read. Refusing the write
 * at the moment it is made, with the correct path in the error, lets the agent
 * retry it in the same turn.
 */
const checkWriteTarget = (tool: string, input: unknown, outFile: string, cwd: string): string | null => {
  if (!outFile) return null;
  if (PATCH_WRITE_TOOLS.has(tool)) {
    return `The "${tool}" tool is not available in a review. Write your output with the write tool, to \`${outFile}\`.`;
  }
  if (!PATH_WRITE_TOOLS.has(tool)) return null;
  const fields = (input ?? {}) as { path?: unknown; filePath?: unknown };
  const targets = [fields.path, fields.filePath].filter((target) => target !== undefined);
  // Do not trust one spelling when the call supplies conflicting aliases.
  if (targets.length > 0 && targets.every((target) =>
    typeof target === "string" && path.resolve(cwd, target) === path.resolve(cwd, outFile),
  )) return null;
  return (
    `Writing to "${targets.map(String).join(", ") || "undefined"}" is refused. The only file you may write is \`${outFile}\` — ` +
    `copy that path exactly as given, character for character. Nothing else may be written during a review.`
  );
};

/**
 * Content parts that are not blocks in the provider's sense. A message can end
 * with one of these after its last real block.
 */
const isFramePart = (type: string): boolean => type === "effort" || type.startsWith("step");
const isThinkingPart = (type: string): boolean => type === "reasoning" || type === "thinking";

type ContentPart = { type?: string };
type RepairableMessage = { role?: string; content?: readonly ContentPart[] };

/**
 * Drop a thinking block left at the end of an assistant message.
 *
 * Anthropic refuses any request whose history contains an assistant message
 * whose final block is `thinking`, with `messages.N: The final block in an
 * assistant message cannot be "thinking"`. The refusal is fatal: it happens
 * while rebuilding the whole history, so the session cannot continue and the
 * slice delivers nothing. Measured on PR #13202 under OpenCode V1 it killed two
 * consecutive runs at step 9 and step 5, $1.12 for no review. Whether V2 can
 * still produce such a history is not established, so the guard stays; it only
 * ever acts on a request that would otherwise fail.
 *
 * Dropping the block is safe: Anthropic requires thinking blocks be preserved
 * only where they precede a tool call in the same turn, and a block in final
 * position by definition precedes nothing.
 *
 * The history's messages may be frozen, so an affected message is replaced in
 * the array with a copy rather than edited in place.
 */
const repairTrailingThinking = (messages: RepairableMessage[]): number => {
  let repaired = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const content = message.content;
    let last = content.length - 1;
    while (last >= 0 && isFramePart(content[last]?.type ?? "")) last--;
    if (last < 0 || !isThinkingPart(content[last]?.type ?? "")) continue;
    const copy = Object.assign(Object.create(Object.getPrototypeOf(message)), message, {
      content: content.filter((_, j) => j !== last),
    });
    messages[i] = copy;
    repaired++;
  }
  return repaired;
};

type Tokens = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

/** Metadata attached by the runner before the first prompt of a shared session. */
export type GovernorSessionConfig = {
  version: 1;
  runID: string;
  tag: string;
  startedAt: number;
  budgetUsd: number;
  deadlineMs: number;
  maxSteps: number;
  outFile: string;
  usageFile: string;
  logFile: string;
  system: string;
  tools: "repo" | "none";
  waitForTools: string;
  expectTools: string[];
};

/** Metadata is an external boundary, even though our runner normally supplies it. */
const sessionConfig = (value: unknown): GovernorSessionConfig => {
  const invalid = () => new Error("review-governor: missing or invalid metadata.diffloupe; this session may not run");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const c = value as Record<string, unknown>;
  const text = (key: string) => typeof c[key] === "string" && c[key].trim().length > 0 && !c[key].includes("\0");
  const number = (key: string) => typeof c[key] === "number" && Number.isFinite(c[key]) && c[key] >= 0;
  if (
    c.version !== 1 ||
    !["runID", "tag", "outFile", "usageFile", "logFile", "system"].every(text) ||
    !["startedAt", "budgetUsd", "deadlineMs", "maxSteps"].every(number) ||
    !Number.isSafeInteger(c.maxSteps) ||
    (c.tools !== "repo" && c.tools !== "none") ||
    typeof c.waitForTools !== "string" ||
    !Array.isArray(c.expectTools) ||
    !c.expectTools.every((id) => typeof id === "string" && id.trim().length > 0)
  ) {
    throw invalid();
  }
  // Keep a snapshot: later metadata changes must not reset accounting or change
  // a session's output permissions after it has started.
  const config = c as GovernorSessionConfig;
  return { ...config, expectTools: [...config.expectTools] };
};

type StepData = { sessionID?: string; cost?: number; tokens?: Tokens };
type SessionRequest = { sessionID?: string };
type ContextRequest = SessionRequest & {
  system?: { type: "text"; text: string }[];
  messages: RepairableMessage[];
  tools?: Record<string, unknown>;
};
type SessionInfo = { metadata?: Record<string, unknown> };
type Registration = { dispose(): Promise<void> };

export type ToolBefore = { tool: string; sessionID?: string; id?: string; input: unknown };
type ToolAfter = { tool: string; sessionID?: string; id?: string; input?: unknown } & (
  | { status: "completed"; result: { readonly content?: unknown } }
  | { status: "error"; error?: unknown }
);

/** The slice of the V2 plugin context this plugin uses. */
export type GovernorContext = {
  event: {
    subscribe(options: { signal: AbortSignal }): AsyncIterable<{ type?: string; data?: unknown }>;
  };
  tool: {
    hook(name: "execute.before", fn: (e: ToolBefore) => void | Promise<void>): Promise<Registration>;
    hook(name: "execute.after", fn: (e: ToolAfter) => void | Promise<void>): Promise<Registration>;
    list(): Promise<readonly { id: string }[]>;
  };
  session: {
    hook(name: "prompt", fn: (e: SessionRequest) => void | Promise<void>): Promise<Registration>;
    hook(name: "context", fn: (e: ContextRequest) => void | Promise<void>): Promise<Registration>;
    get(input: { sessionID: string }): Promise<SessionInfo | { data: SessionInfo }>;
    interrupt(input: { sessionID: string; resume: false }): Promise<unknown>;
  };
};

/** Append text to a tool result, whichever of its two shapes the result has. */
const appendToResult = (result: { readonly content?: unknown }, text: string) => ({
  ...result,
  // Native Tool.Result content is readonly; the hook's result itself is mutable.
  content: typeof result.content === "string"
    ? result.content + text
    : Array.isArray(result.content)
      ? [...result.content, { type: "text", text }]
      : text,
});

/** The abort signal also wakes tool-readiness waits when the plugin unloads. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/** Tool discovery itself can stall, so bound the request as well as the polling. */
const waitBounded = <T>(pending: Promise<T>, ms: number, signal: AbortSignal) =>
  new Promise<T | undefined>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    const stop = () => {
      cleanup();
      resolve(undefined);
    };
    const timer = setTimeout(stop, Math.max(0, ms));
    signal.addEventListener("abort", stop, { once: true });
    pending.then((value) => {
      cleanup();
      resolve(value);
    }, (error) => {
      cleanup();
      reject(error);
    });
    if (signal.aborted) stop();
  });

type StateConfig = Pick<
  GovernorSessionConfig,
  "startedAt" | "budgetUsd" | "deadlineMs" | "maxSteps" | "outFile" | "usageFile" | "logFile" | "waitForTools" | "expectTools"
> & Partial<Pick<GovernorSessionConfig, "system" | "tools" | "runID" | "tag">>;

/** Every mutable value below belongs to exactly one reviewer session. */
function createState(ctx: GovernorContext, config: StateConfig, signal: AbortSignal, initialSessionID = "") {
  const { budgetUsd: budget, deadlineMs, outFile, logFile, usageFile, waitForTools, expectTools, maxSteps, startedAt } = config;
  /**
   * The step count at which only the findings write is left. OpenCode's own
   * `steps` cap ends the session with a text-only turn, so a reviewer that
   * reaches it mid-investigation never writes its file. Measured on one
   * 16-slice PR: DeepSeek V4.1 Flash and MiniMax M3.1 Flash each lost three
   * slices this way, at 80 steps and four to nine minutes, long before the
   * time limit would have nudged them. The reserve leaves room for the write.
   */
  const stepLimit = maxSteps > STEP_RESERVE ? maxSteps - STEP_RESERVE : 0;

  let spent = 0;
  let sessionID = initialSessionID;
  let aborted = false;
  let readiness: Promise<void> | undefined;
  const usage = {
    costUsd: 0,
    numTurns: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      /** The session's first request alone: whether the shared prompt prefix hit the cache. */
      first_step: undefined as
        | { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
        | undefined,
    },
  };
  /** Times each shell rule has been tipped within this session. */
  const warnCounts = new Map<string, number>();
  /** Start times by call ID, so the log can carry how long each tool took. */
  const started = new Map<string, number>();

  /**
   * Written straight to a file rather than through OpenCode's logger, so that a
   * governor decision can still be read back when the run is being diagnosed
   * precisely because the session went wrong.
   */
  const log = (event: string, extra: Record<string, unknown> = {}) => {
    if (!logFile) return;
    try {
      appendFileSync(logFile, JSON.stringify({ t: Date.now(), event, spent, ...(sessionID ? { sessionID } : {}), ...extra }) + "\n");
    } catch {
      /* diagnostics are never worth failing a review over */
    }
  };

  /** No limit of any kind configured means no governing: every stage is inert. */
  const capped = budget > 0 || deadlineMs > 0 || stepLimit > 0;
  const elapsedMs = () => Date.now() - startedAt;
  /** Each limit's progress as a fraction; an unconfigured one stays at zero. */
  const fractions = () => ({
    cost: budget > 0 ? spent / budget : 0,
    time: deadlineMs > 0 ? elapsedMs() / deadlineMs : 0,
    steps: stepLimit > 0 ? usage.numTurns / stepLimit : 0,
  });
  /**
   * How far along the binding limit is, as a fraction. An unconfigured limit
   * contributes zero and so can never be the binding one; otherwise the one
   * nearest its ceiling decides, which makes cost, time and steps a single
   * ladder rather than several that have to agree.
   */
  const pressure = () => Math.max(...Object.values(fractions()));
  /** Which limit is in force, for messages the model reads. */
  const binding = (): "cost" | "time" | "steps" => {
    const f = fractions();
    if (f.steps > f.time && f.steps > f.cost) return "steps";
    return deadlineMs > 0 && (budget <= 0 || f.time >= f.cost) ? "time" : "cost";
  };
  /** One clause naming the limit that is out, in the units it is measured in. */
  const limitNote = () => {
    const b = binding();
    if (b === "steps") return `Step limit reached: ${usage.numTurns} of ${stepLimit} steps`;
    return b === "time"
      ? `Time limit reached: ${Math.round(elapsedMs() / 1000)}s of ${Math.round(deadlineMs / 1000)}s`
      : `Budget exhausted: $${spent.toFixed(2)} of $${budget.toFixed(2)}`;
  };
  const over = () => capped && pressure() >= 1;
  const delivered = () => outFile !== "" && existsSync(outFile);

  const onStep = async (step: StepData) => {
    if (!sessionID && step.sessionID) sessionID = step.sessionID;
    const cost = step.cost ?? 0;
    spent += cost;
    usage.costUsd += cost;
    usage.numTurns += 1;
    usage.usage.first_step ??= {
      input_tokens: step.tokens?.input ?? 0,
      cache_read_input_tokens: step.tokens?.cache?.read ?? 0,
      cache_creation_input_tokens: step.tokens?.cache?.write ?? 0,
    };
    usage.usage.input_tokens += step.tokens?.input ?? 0;
    usage.usage.output_tokens += step.tokens?.output ?? 0;
    usage.usage.reasoning_tokens += step.tokens?.reasoning ?? 0;
    usage.usage.cache_read_input_tokens += step.tokens?.cache?.read ?? 0;
    usage.usage.cache_creation_input_tokens += step.tokens?.cache?.write ?? 0;
    if (usageFile) {
      try {
        writeFileSync(usageFile, JSON.stringify(usage));
      } catch {
        /* the stream total is the fallback */
      }
    }
    log("step", { cost, ms: elapsedMs(), tokens: step.tokens ?? null });

    if (!capped || aborted || pressure() < ABORT_AT) return;
    if (delivered()) return;
    if (!sessionID) return;
    aborted = true;
    log("abort", { sessionID });
    try {
      await ctx.session.interrupt({ sessionID, resume: false });
    } catch (error) {
      log("abort-failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const waitForReadyTools = async () => {
    if (!waitForTools || config.tools === "none") return;
    const begun = Date.now();
    while (!signal.aborted && Date.now() - begun < TOOL_WAIT_MS) {
      try {
        const tools = await waitBounded(ctx.tool.list(), TOOL_WAIT_MS - (Date.now() - begun), signal);
        if (signal.aborted) return;
        if (tools === undefined) break;
        const ids = tools.map((t) => t.id);
        const matched = ids.filter((id) => id.startsWith(waitForTools));
        if (matched.length) {
          // Builds of one tool can share a version number and differ in what
          // they expose, so the list itself is the record of which one ran.
          const missing = expectTools.filter((id) => !ids.includes(id));
          log("tools-ready", { ms: Date.now() - begun, tools: matched, ...(missing.length ? { missing } : {}) });
          if (missing.length) console.error(`review-governor: guidance names tools this session lacks: ${missing.join(", ")}`);
          return;
        }
      } catch {
        /* keep waiting; the timeout below still bounds it */
      }
      await sleep(250, signal);
    }
    if (!signal.aborted) log("tools-missing", { prefix: waitForTools, ms: Date.now() - begun });
  };
  // A second prompt must join the first wait, rather than bypass it while MCP
  // is still connecting. Both the promise and its result belong to the session.
  const prompt = () => (readiness ??= waitForReadyTools());

  const context = (request: ContextRequest) => {
    if (config.system !== undefined) request.system = [{ type: "text", text: config.system }];
    if (config.tools === "none" && request.tools) {
      request.tools = Object.fromEntries(Object.entries(request.tools).filter(([id]) => id === "write"));
    }
    // Mutating the message list is not the same as mutating the system
    // prompt: these are the turns after the cached prefix, so a repair here
    // does not invalidate the cache.
    try {
      const repaired = repairTrailingThinking(request.messages ?? []);
      if (repaired > 0) log("repair-trailing-thinking", { repaired });
    } catch (error) {
      log("repair-failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const after = (call: ToolAfter) => {
    const begun = call.id ? started.get(call.id) : undefined;
    if (call.id) started.delete(call.id);
    // Logged here rather than only in `before`, so that the next command that
    // spends two minutes returning nothing is one line in this file instead of
    // an afternoon decoding the event stream.
    log("tool-done", { tool: call.tool, status: call.status, ms: begun !== undefined ? Date.now() - begun : null });
    if (call.status !== "completed") return;

    const input = (call.input ?? {}) as { command?: unknown };
    const command = call.tool === "shell" && typeof input.command === "string" ? input.command : "";
    const shell = command ? checkShellCommand(command) : null;
    const builtin = call.tool === "shell" ? null : checkBuiltinTool(call.tool);
    const hit = shell && !shell.deny ? shell : builtin;
    if (hit) {
      const advise = "adviseOnly" in hit && hit.adviseOnly;
      const n = warnCounts.get(hit.rule) ?? 0;
      // Appended to the tool's own result rather than pushed into the system
      // prompt: same words, no cache invalidation.
      call.result = appendToResult(
        call.result,
        `\n\n[tool tip ${advise ? n : `${n}/${WARN_LIMIT}`}] ${hit.tip}` +
          (!advise && n >= WARN_LIMIT ? " Further uses this session will be refused." : ""),
      );
    }

    if (!capped || over() || pressure() < NUDGE_AT) return;
    // Above the limit this is silent, because the refusal in `execute.before`
    // carries the message.
    const b = binding();
    const used =
      b === "steps"
        ? `You have used ${usage.numTurns} of ${stepLimit} steps.`
        : b === "time"
          ? `You have used ${Math.round(elapsedMs() / 1000)}s of a ${Math.round(deadlineMs / 1000)}s time limit.`
          : `You have spent $${spent.toFixed(2)} of a $${budget.toFixed(2)} budget.`;
    call.result = appendToResult(
      call.result,
      `\n\n[WRAP UP] ${used} ` +
        `Begin wrapping up: finish the investigation you are in the middle of, and write your ` +
        `findings file before the limit runs out. A file with fewer findings is worth far more ` +
        `than no file at all.`,
    );
    log("nudge", { tool: call.tool, binding: binding() });
  };

  const before = (call: ToolBefore) => {
    if (!sessionID && call.sessionID) sessionID = call.sessionID;
    if (config.tools === "none" && call.tool !== "write") {
      throw new Error(`The "${call.tool}" tool is not available in this session. Only writing your output file is permitted.`);
    }
    if (call.id) started.set(call.id, Date.now());

    if (call.tool === "shell") {
      const input = (call.input ?? {}) as { command?: unknown; timeout?: unknown; background?: unknown };
      const command = typeof input.command === "string" ? input.command : "";
      // Applied to every shell call, including the ones no rule below matches.
      // An unset timeout is the two-minute default and zero means none, so
      // both are capped too.
      const asked = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : Infinity;
      if (asked > MAX_SHELL_MS) input.timeout = MAX_SHELL_MS;
      // A background command has no timeout at all and outlives the call that
      // started it; nothing a reviewer runs needs one.
      if (input.background) input.background = false;

      const hit = command ? checkShellCommand(command) : null;
      if (hit) {
        const n = (warnCounts.get(hit.rule) ?? 0) + 1;
        warnCounts.set(hit.rule, n);
        const refuse = hit.deny || n > WARN_LIMIT;
        log("bash-rule", { rule: hit.rule, count: n, refused: refuse, ms: elapsedMs(), command });
        // Throwing hands the message to the model verbatim as the tool's
        // error, which is the only channel that can explain itself. Warned
        // patterns get WARN_LIMIT uses first, because an unattended reviewer
        // refused a tool it was relying on can burn its remaining turns
        // flailing; a refusal it has been told about three times cannot
        // surprise it.
        if (refuse) throw new Error(`Do not ${hit.tip}`);
      }
    } else {
      // Past the limit with the file delivered, the refusal below says the
      // review is complete, which is the more useful thing to hear.
      const refusal = over() && delivered() ? null : checkWriteTarget(call.tool, call.input, outFile, process.cwd());
      if (refusal) {
        log("write-refused", { tool: call.tool, refusal });
        throw new Error(refusal);
      }
      // Same ladder, applied to the built-in tools that duplicate a tilth
      // tool. Kept separate from the shell path because these have no command
      // string to inspect: the tool's own name is the whole signal.
      const hit = checkBuiltinTool(call.tool);
      if (hit) {
        const n = (warnCounts.get(hit.rule) ?? 0) + 1;
        warnCounts.set(hit.rule, n);
        const refuse = !hit.adviseOnly && n > WARN_LIMIT;
        log("builtin-rule", { rule: hit.rule, tool: call.tool, count: n, refused: refuse, ms: elapsedMs() });
        if (refuse) throw new Error(`Do not ${hit.tip}`);
      }
    }

    if (!over()) {
      log("tool", { tool: call.tool, allowed: true });
      return;
    }
    // Once the findings file is on disk there is nothing left worth paying
    // for, so the write goes too and the agent runs out of moves.
    const allow = call.tool === "write" && !delivered();
    log("tool", { tool: call.tool, allowed: allow });
    if (allow) return;
    throw new Error(
      delivered()
        ? `${limitNote()}, and your findings file has been written. This review is complete. ` +
            `Stop calling tools and finish your turn.`
        : `${limitNote()}. The "${call.tool}" tool ` +
            `is switched off. Write your findings file now with what you have already established — ` +
            `that is the only tool still available, and an unwritten file means this review is lost.`,
    );
  };

  log("setup", { budget, deadlineMs, stepLimit, cwd: process.cwd(), runID: config.runID, tag: config.tag });
  return { onStep, prompt, context, before, after, log };
}

type GovernorState = ReturnType<typeof createState>;

async function setup(ctx: GovernorContext) {
  const shared = process.env.REVIEW_GOVERNOR_SESSIONS === "1";
  const events = new AbortController();
  const disposers: (() => Promise<void>)[] = [];
  const legacy = shared ? undefined : createState(ctx, {
    budgetUsd: Number(process.env.REVIEW_GOVERNOR_BUDGET_USD ?? 0),
    deadlineMs: Number(process.env.REVIEW_GOVERNOR_DEADLINE_MS ?? 0),
    maxSteps: Number(process.env.REVIEW_GOVERNOR_MAX_STEPS ?? 0),
    outFile: process.env.REVIEW_GOVERNOR_OUT_FILE ?? "",
    logFile: process.env.REVIEW_GOVERNOR_LOG ?? "",
    usageFile: process.env.REVIEW_GOVERNOR_USAGE_FILE ?? "",
    waitForTools: process.env.REVIEW_GOVERNOR_WAIT_FOR_TOOLS ?? "",
    expectTools: (process.env.REVIEW_GOVERNOR_EXPECT_TOOLS ?? "").split(",").filter(Boolean),
    startedAt: Date.now(),
  }, events.signal);
  const sessions = new Map<string, Promise<GovernorState>>();
  const stepQueues = new Map<string, Promise<void>>();
  const stateFor = (sessionID?: string): Promise<GovernorState> => {
    if (events.signal.aborted) return Promise.reject(new Error("review-governor: plugin disposed"));
    if (!sessionID) return Promise.reject(new Error("review-governor: missing sessionID; this session may not run"));
    let pending = sessions.get(sessionID);
    if (!pending) {
      // Cache before fetching metadata: overlapping prompts, tools, and final
      // step events must all initialize and charge the same state exactly once.
      pending = Promise.resolve().then(async () => {
        const info = await ctx.session.get({ sessionID });
        // The promise client returns Session.Info directly. Also accept the
        // response envelope used by callers of the underlying service API.
        const config = sessionConfig(("data" in info ? info.data : info).metadata?.diffloupe);
        if (events.signal.aborted) throw new Error("review-governor: plugin disposed");
        return createState(ctx, config, events.signal, sessionID);
      });
      sessions.set(sessionID, pending);
    }
    return pending;
  };
  const withState = <T extends SessionRequest>(action: (state: GovernorState, request: T) => void | Promise<void>) =>
    (request: T) => {
      // Keep the standalone hooks synchronous where they were synchronous.
      if (legacy) return action(legacy, request);
      return stateFor(request.sessionID).then((state) => {
        if (events.signal.aborted) throw new Error("review-governor: plugin disposed");
        return action(state, request);
      });
    };
  const register = async (registration: Promise<Registration>) => {
    const registered = await registration;
    disposers.push(() => registered.dispose());
  };
  const cleanup = async () => {
    events.abort();
    sessions.clear();
    stepQueues.clear();
    await Promise.allSettled(disposers.splice(0).reverse().map(async (dispose) => dispose()));
  };
  try {
    await register(ctx.session.hook("prompt", withState((state) => state.prompt())));
    await register(ctx.session.hook("context", withState<ContextRequest>((state, request) => state.context(request))));
    await register(ctx.tool.hook("execute.after", withState<ToolAfter>((state, call) => state.after(call))));
    await register(ctx.tool.hook("execute.before", withState<ToolBefore>((state, call) => state.before(call))));
  } catch (error) {
    await cleanup();
    throw error;
  }

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) {
        if (events.signal.aborted) break;
        if (event.type !== "session.step.ended" && event.type !== "session.step.failed") continue;
        const data = (event.data ?? {}) as StepData;
        // Failed steps without billing/usage are not turns. Final text-only steps
        // arrive here too, unlike the CLI's stdout stream.
        if (event.type === "session.step.failed" && data.cost === undefined && data.tokens === undefined) continue;
        const charge = async () => {
          try {
            const state = legacy ?? await stateFor(data.sessionID);
            if (!events.signal.aborted) await state.onStep(data);
          } catch {
            // Parent and unregistered sessions never own reviewer accounting.
            // One invalid session must not stop the shared event subscription.
          }
        };
        if (legacy) {
          await charge();
          continue;
        }
        if (!data.sessionID) continue;
        const sessionID = data.sessionID;
        // Preserve billing order within each reviewer, but never hold another
        // reviewer's accounting behind a metadata lookup or interrupt request.
        const pending = (stepQueues.get(sessionID) ?? Promise.resolve()).then(charge);
        stepQueues.set(sessionID, pending);
        void pending.then(() => {
          if (stepQueues.get(sessionID) === pending) stepQueues.delete(sessionID);
        });
      }
    } catch (error) {
      if (!events.signal.aborted) {
        legacy?.log("events-failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  })();
  return cleanup;
}

/** Exposed for the tests. Not a plugin; OpenCode loads only the default export. */
export const helpers = { checkShellCommand, checkBuiltinTool, checkWriteTarget, repairTrailingThinking };

export default { id: "review-governor", setup };
