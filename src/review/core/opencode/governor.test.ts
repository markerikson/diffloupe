
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as governorModule from "./governor.ts";
import governor, { helpers, type GovernorContext, type ToolBefore } from "./governor.ts";

const { checkShellCommand } = helpers;

type Handler = (e: never) => unknown;

/**
 * The governor reads the wall clock, so the time stages are driven by moving it
 * rather than by sleeping. Restored after every test whether one moved it or not.
 */
const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
});

/** Let the governor's event loop take every event already queued. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A stand-in for the part of the OpenCode plugin context the governor uses:
 * hooks are captured so the tests can call them the way OpenCode would, and
 * events are fed through a queue the governor subscribes to.
 */
const fakeContext = (toolIds: () => string[] = () => []) => {
  const hooks = new Map<string, Handler>();
  const interrupted: string[] = [];
  const queue: { type: string; data: unknown }[] = [];
  let wake: (() => void) | undefined;
  const ctx: GovernorContext = {
    event: {
      subscribe: ({ signal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            const next = queue.shift();
            if (next) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        },
      }),
    },
    tool: {
      hook: (name: string, fn: Handler) => {
        hooks.set(`tool.${name}`, fn);
      },
      list: async () => toolIds().map((id) => ({ id })),
    },
    session: {
      hook: (name: string, fn: Handler) => {
        hooks.set(`session.${name}`, fn);
      },
      async interrupt({ sessionID }) {
        interrupted.push(sessionID);
      },
    },
  } as GovernorContext;
  const emit = async (type: string, data: unknown) => {
    queue.push({ type, data });
    wake?.();
    await flush();
  };
  const hook = (name: string) => hooks.get(name) as (e: unknown) => unknown;
  return { ctx, hooks, hook, emit, interrupted };
};

const setup = async (
  opts: {
    budget?: number;
    outFile?: string;
    deadlineMs?: number;
    maxSteps?: number;
    usageFile?: string;
    waitFor?: string;
  } = {},
) => {
  const env = { ...process.env };
  let clock = realNow();
  Date.now = () => clock;
  process.env.REVIEW_GOVERNOR_BUDGET_USD = String(opts.budget ?? 1);
  process.env.REVIEW_GOVERNOR_DEADLINE_MS = String(opts.deadlineMs ?? 0);
  process.env.REVIEW_GOVERNOR_MAX_STEPS = String(opts.maxSteps ?? 0);
  process.env.REVIEW_GOVERNOR_OUT_FILE = opts.outFile ?? "";
  process.env.REVIEW_GOVERNOR_USAGE_FILE = opts.usageFile ?? "";
  process.env.REVIEW_GOVERNOR_WAIT_FOR_TOOLS = opts.waitFor ?? "";
  delete process.env.REVIEW_GOVERNOR_LOG;
  const fake = fakeContext();
  const cleanup = await governor.setup(fake.ctx);
  process.env = env;
  onTestFinished(() => cleanup());

  /** Charge the session, which is the only thing that moves any of the stages. */
  const spend = async (amount: number, tokens: Record<string, unknown> = {}) => {
    await fake.emit("session.step.ended", { sessionID: "ses_1", cost: amount, tokens });
  };
  /** The wrap-up text a completed tool call would carry back, or null if none. */
  const nudge = (name = "tilth_tilth_read") => {
    const call = { tool: name, id: "c0", input: {}, status: "completed", result: { content: "TOOL RESULT" } };
    fake.hook("tool.execute.after")(call);
    return call.result.content === "TOOL RESULT" ? null : call.result.content;
  };
  /** Whether a tool call would be permitted, and the refusal if it would not. */
  const tool = (name: string) => {
    try {
      fake.hook("tool.execute.before")({ tool: name, sessionID: "ses_1", id: "c0", input: {} });
      return { allowed: true, message: "" };
    } catch (error) {
      return { allowed: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  /**
   * Run a shell command through both tool hooks the way OpenCode would, and
   * report what the governor did to it: whether it was refused, what the model
   * was told, and what input the command was left with.
   */
  const shell = (command: string, input: Record<string, unknown> = {}) => {
    const merged: Record<string, unknown> = { command, ...input };
    const before: ToolBefore = { tool: "shell", sessionID: "ses_1", id: "c1", input: merged };
    try {
      fake.hook("tool.execute.before")(before);
    } catch (error) {
      return { allowed: false, message: error instanceof Error ? error.message : String(error), input: merged };
    }
    const call = { tool: "shell", id: "c1", input: merged, status: "completed", result: { content: "COMMAND OUTPUT" } };
    fake.hook("tool.execute.after")(call);
    return { allowed: true, message: call.result.content, input: merged };
  };
  /** Run a built-in tool through both hooks and report refusal plus any tip. */
  const builtin = (name: string) => {
    try {
      fake.hook("tool.execute.before")({ tool: name, sessionID: "ses_1", id: "c1", input: {} });
    } catch (error) {
      return { allowed: false, message: error instanceof Error ? error.message : String(error) };
    }
    const call = { tool: name, id: "c1", input: {}, status: "completed", result: { content: "TOOL OUTPUT" } };
    fake.hook("tool.execute.after")(call);
    return { allowed: true, message: call.result.content };
  };
  /** Move the session's wall clock forward without spending anything. */
  const wait = (ms: number) => {
    clock += ms;
  };
  return { spend, nudge, tool, shell, builtin, wait, ...fake };
};

const deliveredFile = () => {
  const p = path.join(mkdtempSync(path.join(os.tmpdir(), "gov-")), "findings.json");
  writeFileSync(p, "{}");
  return p;
};

describe("opencode spend governor", () => {
  it("does nothing at all without a budget, so an unconfigured run is not throttled", async () => {
    const g = await setup({ budget: 0 });
    await g.spend(1000);
    expect(g.nudge()).toBeNull();
    expect(g.tool("shell").allowed).toBe(true);
    expect(g.interrupted).toEqual([]);
  });

  it("stays quiet below the wrap-up threshold, so most of the budget buys real work", async () => {
    const g = await setup({ budget: 1 });
    await g.spend(0.7);
    expect(g.nudge()).toBeNull();
    expect(g.tool("shell").allowed).toBe(true);
  });

  it("asks the agent to wrap up before the budget is gone, while it can still finish", async () => {
    const g = await setup({ budget: 1 });
    await g.spend(0.8);
    expect(g.nudge()).toContain("WRAP UP");
    // Still working: the warning is advice, not enforcement.
    expect(g.tool("shell").allowed).toBe(true);
  });

  it("carries the notice on top of the tool's own result, not instead of it", async () => {
    const g = await setup({ budget: 1 });
    await g.spend(0.8);
    expect(g.nudge()).toContain("TOOL RESULT");
  });

  it("appends to a result made of content parts as well as to a plain string", async () => {
    const g = await setup({ budget: 1 });
    await g.spend(0.8);
    const content: unknown[] = [{ type: "text", text: "FILE" }];
    g.hook("tool.execute.after")({ tool: "tilth_tilth_read", id: "c5", status: "completed", result: { content } });
    expect(content).toHaveLength(2);
    expect(JSON.stringify(content[1])).toContain("WRAP UP");
  });

  it("stops nudging above the budget, where the tool refusal carries the message", async () => {
    const g = await setup({ budget: 1 });
    await g.spend(1.2);
    expect(g.nudge()).toBeNull();
  });

  it("never speaks through the system prompt, which is the prompt cache prefix", async () => {
    // Appending to the system prompt invalidated the cache and made a step ten
    // times more expensive. Every governor message has to ride on a tool result.
    const g = await setup({ budget: 1 });
    await g.spend(1.2);
    const system = [{ type: "text", text: "SYSTEM" }];
    const messages = [{ role: "assistant", content: [{ type: "text" }] }];
    await g.hook("session.context")({ system, messages });
    expect(system).toEqual([{ type: "text", text: "SYSTEM" }]);
    expect(messages[0].content).toEqual([{ type: "text" }]);
  });

  it("leaves the findings write reachable over budget, because a killed slice reports nothing", async () => {
    const g = await setup({ budget: 1 });
    await g.spend(1.2);
    expect(g.tool("write").allowed).toBe(true);
  });

  it("refuses every other tool over budget, so the write is the only move left", async () => {
    const g = await setup({ budget: 1 });
    await g.spend(1.2);
    for (const name of ["shell", "read", "grep", "glob", "edit", "tilth_tilth_read"]) {
      expect(g.tool(name).allowed).toBe(false);
    }
  });

  it("tells the agent to write its file in the refusal, since the model only sees that text", async () => {
    const g = await setup({ budget: 1 });
    await g.spend(1.2);
    expect(g.tool("shell").message).toContain("Write your findings file now");
  });

  it("refuses the write too once the file exists, which ends the session with nothing to call", async () => {
    const g = await setup({ budget: 1, outFile: deliveredFile() });
    await g.spend(1.2);
    const attempt = g.tool("write");
    expect(attempt.allowed).toBe(false);
    expect(attempt.message).toContain("complete");
  });

  it("interrupts an agent that is far over budget with no findings file, having nothing to lose", async () => {
    const g = await setup({ budget: 1 });
    await g.spend(2.5);
    expect(g.interrupted).toEqual(["ses_1"]);
  });

  it("never interrupts once findings are on disk", async () => {
    const g = await setup({ budget: 1, outFile: deliveredFile() });
    await g.spend(2.5);
    expect(g.interrupted).toEqual([]);
  });

  it("interrupts once, not on every later step", async () => {
    const g = await setup({ budget: 1 });
    await g.spend(2.5);
    await g.spend(1);
    await g.spend(1);
    expect(g.interrupted).toEqual(["ses_1"]);
  });

  it("does not interrupt merely for being over budget, which the tool refusals already handle", async () => {
    const g = await setup({ budget: 1 });
    await g.spend(1.4);
    expect(g.interrupted).toEqual([]);
  });

  it("nudges on step count, so a cheap fast model is warned before OpenCode's step cap", async () => {
    // 80 steps leaves 75 before the reserve; 75% of that is 56.25.
    const g = await setup({ budget: 10, maxSteps: 80 });
    for (let i = 0; i < 56; i++) await g.spend(0.001);
    expect(g.nudge()).toBeNull();
    await g.spend(0.001);
    expect(g.nudge()).toContain("57 of 75 steps");
  });

  it("leaves only the findings write once the step limit is reached", async () => {
    const g = await setup({ budget: 10, maxSteps: 80 });
    for (let i = 0; i < 75; i++) await g.spend(0.001);
    expect(g.tool("tilth_tilth_read").message).toContain("Step limit reached: 75 of 75 steps");
    expect(g.tool("write").allowed).toBe(true);
    expect(g.interrupted).toEqual([]);
  });

  it("accumulates cost across steps rather than judging each one alone", async () => {
    const g = await setup({ budget: 1 });
    // Three steps that are individually well under budget, and a fourth that
    // takes the total past it.
    for (let i = 0; i < 3; i++) await g.spend(0.3);
    expect(g.tool("shell").allowed).toBe(true);
    await g.spend(0.3);
    expect(g.tool("shell").allowed).toBe(false);
  });

  it("ignores events that are not steps, so usage reports are not charged twice", async () => {
    const g = await setup({ budget: 1 });
    await g.emit("session.usage.updated", { sessionID: "ses_1", cost: 5 });
    await g.emit("session.tool.called", { sessionID: "ses_1", cost: 5 });
    expect(g.nudge()).toBeNull();
    expect(g.tool("shell").allowed).toBe(true);
  });

  it("charges a failed step that reports a cost, and skips one that does not", async () => {
    const g = await setup({ budget: 1 });
    await g.emit("session.step.failed", { sessionID: "ses_1" });
    expect(g.tool("shell").allowed).toBe(true);
    await g.emit("session.step.failed", { sessionID: "ses_1", cost: 1.1 });
    expect(g.tool("shell").allowed).toBe(false);
  });
});

describe("usage accounting", () => {
  it("writes running totals from the step events, which include the step the stdout stream drops", async () => {
    const usageFile = path.join(mkdtempSync(path.join(os.tmpdir(), "gov-")), "usage.json");
    const g = await setup({ budget: 0, usageFile });
    await g.spend(0.5, { input: 10, output: 1, reasoning: 3, cache: { read: 900, write: 40 } });
    await g.spend(0.25, { input: 20, output: 2 });
    const totals = JSON.parse(readFileSync(usageFile, "utf8"));
    expect(totals.costUsd).toBeCloseTo(0.75);
    expect(totals.numTurns).toBe(2);
    expect(totals.usage).toEqual({
      input_tokens: 30,
      output_tokens: 3,
      reasoning_tokens: 3,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 40,
      first_step: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 },
    });
  });

  it("keeps the first step's prompt tokens from the first step, not a later one", async () => {
    const usageFile = path.join(mkdtempSync(path.join(os.tmpdir(), "gov-")), "usage.json");
    const g = await setup({ budget: 0, usageFile });
    await g.spend(0.1, { input: 4, cache: { read: 0, write: 600 } });
    await g.spend(0.1, { input: 1, cache: { read: 600, write: 0 } });
    await g.spend(0.1, { input: 2, cache: { read: 700, write: 0 } });
    const totals = JSON.parse(readFileSync(usageFile, "utf8"));
    expect(totals.usage.first_step).toEqual({
      input_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 600,
    });
  });
});

describe("waiting for MCP tools", () => {
  it("holds the first request until a tool with the named prefix is registered", async () => {
    Date.now = realNow;
    let ids = ["read", "shell"];
    const fake = fakeContext(() => ids);
    const env = { ...process.env };
    process.env.REVIEW_GOVERNOR_WAIT_FOR_TOOLS = "tilth_";
    process.env.REVIEW_GOVERNOR_BUDGET_USD = "0";
    const cleanup = await governor.setup(fake.ctx);
    process.env = env;
    let done = false;
    const pending = Promise.resolve(fake.hook("session.prompt")({})).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(false);
    ids = ["read", "shell", "tilth_tilth_read"];
    await pending;
    expect(done).toBe(true);
    cleanup();
  });

  it("records which tools arrived and which named ones did not", async () => {
    Date.now = realNow;
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), "gov-")), "governor.jsonl");
    const fake = fakeContext(() => ["read", "tilth_tilth_read", "tilth_tilth_search"]);
    const env = { ...process.env };
    process.env.REVIEW_GOVERNOR_WAIT_FOR_TOOLS = "tilth_";
    process.env.REVIEW_GOVERNOR_EXPECT_TOOLS = "tilth_tilth_search,tilth_tilth_files";
    process.env.REVIEW_GOVERNOR_BUDGET_USD = "0";
    process.env.REVIEW_GOVERNOR_LOG = log;
    const cleanup = await governor.setup(fake.ctx);
    process.env = env;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await fake.hook("session.prompt")({});
    cleanup();
    const ready = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.event === "tools-ready");
    expect(ready.tools).toEqual(["tilth_tilth_read", "tilth_tilth_search"]);
    expect(ready.missing).toEqual(["tilth_tilth_files"]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("tilth_tilth_files"));
    errors.mockRestore();
  });

  it("does not wait at all when no prefix is configured", async () => {
    const g = await setup({ budget: 0 });
    const t0 = realNow();
    await g.hook("session.prompt")({});
    expect(realNow() - t0).toBeLessThan(100);
  });
});

describe("checkShellCommand", () => {
  it("names the search tool for bare rg, grep and git grep alike", () => {
    for (const cmd of ["rg secret src", "grep -rn secret src", "git grep secret"]) {
      const hit = checkShellCommand(cmd);
      expect(hit?.rule).toBe("bash-search");
      expect(hit?.deny).toBe(false);
    }
  });

  it("leaves grep alone when it is filtering another command's output", () => {
    expect(checkShellCommand("git log --oneline -20 | grep secret")).toBeNull();
  });

  it("leaves counting and file listing alone, which the structured search answers less directly", () => {
    expect(checkShellCommand("rg -c secret src")).toBeNull();
    expect(checkShellCommand("rg -l secret src")).toBeNull();
  });

  it("catches reading a file through the shell, whole or in slices", () => {
    for (const cmd of ["cat src/shared/config.ts", "sed -n 1,30p src/shared/config.ts", "head -50 src/x.ts"]) {
      expect(checkShellCommand(cmd)?.rule).toBe("bash-read");
    }
  });

  it("leaves log files alone, where reading through the shell is analysis and not code reading", () => {
    expect(checkShellCommand("cat build.log")).toBeNull();
    expect(checkShellCommand("tail -100 /var/log/agent.err")).toBeNull();
  });

  it("does not exempt the review checkout, which lives under /tmp like a scratch file would", () => {
    // The desktop version of these rules waves through anything under /tmp.
    // Here that would switch every rule off for every file under review.
    expect(checkShellCommand("cat /tmp/code-review-subject-abc/src/shared/config.ts")?.rule).toBe("bash-read");
  });

  it("refuses a find that leaves the checkout outright, with no warning ladder first", () => {
    const hit = checkShellCommand('find / -name "SupabaseClient.js" -print');
    expect(hit?.rule).toBe("find-outside-checkout");
    expect(hit?.deny).toBe(true);
  });

  it("only warns about a find inside the checkout, which can at least return something", () => {
    const hit = checkShellCommand("find src -name '*.ts'");
    expect(hit?.rule).toBe("bash-find");
    expect(hit?.deny).toBe(false);
  });

  it("leaves find alone when it is running an action rather than listing files", () => {
    expect(checkShellCommand("find src -name '*.ts' -exec wc -l {} +")).toBeNull();
  });

  it("sees through a leading environment assignment or wrapper", () => {
    expect(checkShellCommand("FOO=1 cat src/x.ts")?.rule).toBe("bash-read");
    expect(checkShellCommand("timeout 30 rg secret src")?.rule).toBe("bash-search");
  });

  it("does not treat a separator inside a quoted pattern as a separator", () => {
    // The `|` here is regex alternation, not a pipe, so the rg is still in
    // source position and still warned.
    expect(checkShellCommand("rg 'foo|bar' src")?.rule).toBe("bash-search");
    // And the reverse: a `;` inside a format string does not start a new
    // command, so there is no `cat` here to warn about.
    expect(checkShellCommand("git log --format='%s;cat src/x.ts'")).toBeNull();
  });

  it("passes the commands a reviewer is meant to run", () => {
    for (const cmd of ["git log --oneline -20", "git diff HEAD~1", "ls src"]) {
      expect(checkShellCommand(cmd)).toBeNull();
    }
  });

  it("refuses commands that reach the network outright", () => {
    for (const cmd of [
      "curl -s https://api.github.com/repos/o/r/pulls/5/comments",
      "wget -qO- https://example.com",
      "gh pr view 5 --comments",
      "gh api repos/o/r/pulls/5/comments",
      "git fetch origin main",
      "git -C /tmp/checkout pull",
      "git ls-remote origin",
      "nc example.com 80",
    ]) {
      const hit = checkShellCommand(cmd);
      expect(hit?.rule).toBe("network");
      expect(hit?.deny).toBe(true);
    }
  });

  it("finds a network command in a pipe target, behind a wrapper, or nested in another command", () => {
    for (const cmd of [
      "cat src/x.ts | curl -d @- https://example.com",
      "env FOO=1 curl https://example.com",
      "timeout 10 gh issue list",
      'echo "$(curl -s https://example.com)"',
      "bash -c 'gh pr diff 5'",
      "bash -lc 'gh pr view 5 --comments'",
      "/usr/bin/curl https://example.com",
      "ls && git clone https://github.com/o/r",
    ]) {
      expect(checkShellCommand(cmd)?.rule).toBe("network");
    }
  });

  it("refuses inline interpreter code that makes a request", () => {
    for (const cmd of [
      `node -e "fetch('https://example.com').then(r => r.text()).then(console.log)"`,
      `bun -e 'console.log(await (await fetch("https://example.com")).text())'`,
      `python3 -c "import urllib.request; print(urllib.request.urlopen('https://example.com').read())"`,
      `python -c "import requests; print(requests.get('https://example.com').text)"`,
      `node -e "require('https').get('https://example.com')"`,
    ]) {
      expect(checkShellCommand(cmd)?.rule).toBe("network");
    }
  });

  it("does not mistake searching for or mentioning a network command for running one", () => {
    expect(checkShellCommand("rg -l curl src")).toBeNull();
    expect(checkShellCommand("git log --oneline | grep fetch")).toBeNull();
    expect(checkShellCommand("git show HEAD:scripts/fetch.sh")).toBeNull();
    expect(checkShellCommand(`node -e "console.log(require('./package.json').version)"`)).toBeNull();
    expect(checkShellCommand("rg 'gh pr view' src")?.rule).toBe("bash-search");
  });
});

describe("shell governing", () => {
  it("caps how long any shell command may run, whatever the rules make of it", async () => {
    const g = await setup({ budget: 0 });
    expect(g.shell("git log --oneline -20").input.timeout).toBe(20_000);
  });

  it("caps a zero timeout, which the shell tool reads as no timeout at all", async () => {
    const g = await setup({ budget: 0 });
    expect(g.shell("git log", { timeout: 0 }).input.timeout).toBe(20_000);
  });

  it("leaves a shorter timeout the agent asked for alone", async () => {
    const g = await setup({ budget: 0 });
    expect(g.shell("git log", { timeout: 5_000 }).input.timeout).toBe(5_000);
  });

  it("runs a background command in the foreground, where the timeout applies", async () => {
    const g = await setup({ budget: 0 });
    expect(g.shell("sleep 600", { background: true }).input.background).toBe(false);
  });

  it("tips a warned pattern before refusing it, so a reviewer relying on it is not cut off mid-run", async () => {
    const g = await setup({ budget: 0 });
    for (let i = 1; i <= 3; i++) {
      const r = g.shell("git grep secret");
      expect(r.allowed).toBe(true);
      expect(r.message).toContain(`[tool tip ${i}/3]`);
      expect(r.message).toContain("COMMAND OUTPUT");
    }
    const refused = g.shell("git grep secret");
    expect(refused.allowed).toBe(false);
    expect(refused.message).toContain("tilth_tilth_search");
  });

  it("counts each pattern separately, so exhausting one does not refuse another", async () => {
    const g = await setup({ budget: 0 });
    for (let i = 0; i < 4; i++) g.shell("git grep secret");
    expect(g.shell("cat src/x.ts").allowed).toBe(true);
  });

  it("refuses a filesystem-wide find on its first use", async () => {
    const g = await setup({ budget: 0 });
    const r = g.shell('find / -name "SupabaseClient.js"');
    expect(r.allowed).toBe(false);
    expect(r.message).toContain("no dependencies installed");
  });

  it("refuses a network command on its first use", async () => {
    const g = await setup({ budget: 0 });
    const r = g.shell("gh pr view 5 --comments");
    expect(r.allowed).toBe(false);
    expect(r.message).toContain("Do not reach the network");
  });

  it("governs the shell even with no spend budget configured", async () => {
    // The two caps are independent: a run with the budget switched off still
    // gets the tool rules, and a command that costs nothing can still waste
    // two minutes.
    const g = await setup({ budget: 0 });
    expect(g.shell("find /usr -name x").allowed).toBe(false);
  });

  it("says nothing about tools that are not the shell", async () => {
    const g = await setup({ budget: 0 });
    const call = { tool: "tilth_tilth_read", id: "c9", status: "completed", result: { content: "FILE CONTENTS" } };
    g.hook("tool.execute.after")(call);
    expect(call.result.content).toBe("FILE CONTENTS");
  });

  it("adds nothing to a call that failed, which has no result to carry it", async () => {
    const g = await setup({ budget: 0 });
    expect(() =>
      g.hook("tool.execute.after")({ tool: "grep", id: "c9", status: "error", error: { message: "x" } }),
    ).not.toThrow();
  });
});

describe("plugin module shape", () => {
  it("default-exports a plugin definition and no other function, so nothing else can be taken for a plugin", () => {
    expect(governor.id).toBe("review-governor");
    expect(typeof governor.setup).toBe("function");
    const fns = Object.entries(governorModule).filter(([, v]) => typeof v === "function");
    expect(fns).toEqual([]);
  });
});

describe("repairTrailingThinking", () => {
  const { repairTrailingThinking } = helpers;
  const assistant = (...types: string[]) => ({ role: "assistant", content: types.map((type) => ({ type })) });
  const types = (m: { content?: readonly { type?: string }[] }) => (m.content ?? []).map((p) => p.type);

  it("drops a thinking block sitting in final position, which Anthropic refuses outright", () => {
    const messages = [assistant("reasoning", "tool-call", "reasoning")];
    expect(repairTrailingThinking(messages)).toBe(1);
    expect(types(messages[0])).toEqual(["reasoning", "tool-call"]);
  });

  it("looks past the effort marker a message can end with, which is not a block the provider sees", () => {
    const messages = [assistant("reasoning", "effort")];
    expect(repairTrailingThinking(messages)).toBe(1);
    expect(types(messages[0])).toEqual(["effort"]);
  });

  it("keeps a thinking block that precedes a tool call, where the provider requires it verbatim", () => {
    const messages = [assistant("reasoning", "tool-call")];
    expect(repairTrailingThinking(messages)).toBe(0);
    expect(types(messages[0])).toEqual(["reasoning", "tool-call"]);
  });

  it("leaves messages that do not end in thinking alone", () => {
    expect(repairTrailingThinking([assistant("reasoning", "text")])).toBe(0);
  });

  it("leaves user messages alone, where a thinking part would not be ours to remove", () => {
    const messages = [{ role: "user", content: [{ type: "reasoning" }] }];
    expect(repairTrailingThinking(messages)).toBe(0);
    expect(types(messages[0])).toEqual(["reasoning"]);
  });

  it("replaces a frozen message with a repaired copy instead of editing it", () => {
    const frozen = Object.freeze({ role: "assistant", content: Object.freeze([{ type: "text" }, { type: "reasoning" }]) });
    const messages = [frozen];
    expect(repairTrailingThinking(messages)).toBe(1);
    expect(messages[0]).not.toBe(frozen);
    expect(types(messages[0])).toEqual(["text"]);
    expect(types(frozen)).toEqual(["text", "reasoning"]);
  });

  it("repairs every affected message in the history, not just the last", () => {
    const messages = [assistant("reasoning"), assistant("text"), assistant("tool-call", "thinking")];
    expect(repairTrailingThinking(messages)).toBe(2);
    expect(types(messages[0])).toEqual([]);
    expect(types(messages[2])).toEqual(["tool-call"]);
  });
});

describe("time limit", () => {
  it("does not govern on time unless a deadline is configured", async () => {
    const g = await setup({ budget: 1, deadlineMs: 0 });
    g.wait(60 * 60 * 1000);
    expect(g.nudge()).toBeNull();
    expect(g.tool("shell").allowed).toBe(true);
  });

  it("asks the agent to wrap up as the deadline approaches, before refusing anything", async () => {
    const g = await setup({ budget: 1, deadlineMs: 1000 });
    g.wait(800);
    const text = g.nudge();
    expect(text).toContain("WRAP UP");
    expect(text).toContain("time limit");
    expect(g.tool("shell").allowed).toBe(true);
  });

  it("refuses every tool but the findings write once the deadline passes", async () => {
    const g = await setup({ budget: 1, deadlineMs: 1000 });
    g.wait(1200);
    const refused = g.tool("shell");
    expect(refused.allowed).toBe(false);
    expect(refused.message).toContain("Time limit reached");
    expect(g.tool("write").allowed).toBe(true);
  });

  it("runs out of time on a cheap model that never approaches its budget", async () => {
    // The case this stage exists for: a $3 slice that spends a dime and keeps
    // going. Every cost stage stays inert, so only the clock can stop it.
    const g = await setup({ budget: 3, deadlineMs: 1000 });
    await g.spend(0.1);
    g.wait(1200);
    expect(g.tool("shell").allowed).toBe(false);
    expect(g.tool("shell").message).toContain("Time limit reached");
  });

  it("names whichever limit is actually binding, so the model is not told the wrong thing", async () => {
    const g = await setup({ budget: 1, deadlineMs: 100000 });
    await g.spend(1.5);
    expect(g.tool("shell").message).toContain("Budget exhausted");
  });

  it("interrupts a session that is far past the deadline with nothing written", async () => {
    const g = await setup({ budget: 1000, deadlineMs: 1000 });
    g.wait(2500);
    await g.spend(0.01);
    expect(g.interrupted).toEqual(["ses_1"]);
  });

  it("never interrupts on time once the findings file is on disk", async () => {
    const g = await setup({ budget: 1000, deadlineMs: 1000, outFile: deliveredFile() });
    g.wait(2500);
    await g.spend(0.01);
    expect(g.interrupted).toEqual([]);
  });
});

describe("time limit without a budget", () => {
  it("governs on time alone, so a deadline works with no spend cap set", async () => {
    const g = await setup({ budget: 0, deadlineMs: 1000 });
    g.wait(1200);
    const refused = g.tool("shell");
    expect(refused.allowed).toBe(false);
    expect(refused.message).toContain("Time limit reached");
    expect(g.tool("write").allowed).toBe(true);
  });
});

describe("built-in tools that duplicate a tilth tool", () => {
  const { checkBuiltinTool } = helpers;

  it("steers the plain grep tool to tilth, since the shell rules cannot see it", () => {
    expect(checkBuiltinTool("grep")?.rule).toBe("builtin-search");
    expect(checkBuiltinTool("grep")?.tip).toContain("tilth_tilth_search");
  });

  it("leaves the tilth tools alone", () => {
    expect(checkBuiltinTool("tilth_tilth_search")).toBeNull();
    expect(checkBuiltinTool("write")).toBeNull();
    expect(checkBuiltinTool("shell")).toBeNull();
  });

  it("advises on the read tool but never refuses it, because a reviewer must be able to read", () => {
    expect(checkBuiltinTool("read")?.adviseOnly).toBe(true);
    expect(checkBuiltinTool("grep")?.adviseOnly).toBe(false);
  });

  it("refuses the grep tool after the same number of tips the shell rules give", async () => {
    const g = await setup({ budget: 10 });
    for (let i = 0; i < 3; i++) expect(g.builtin("grep").allowed).toBe(true);
    const refused = g.builtin("grep");
    expect(refused.allowed).toBe(false);
    expect(refused.message).toContain("tilth_tilth_search");
  });

  it("never refuses the read tool however often it is used", async () => {
    const g = await setup({ budget: 10 });
    for (let i = 0; i < 8; i++) expect(g.builtin("read").allowed).toBe(true);
  });

  it("carries the tip on the tool's own result", async () => {
    const g = await setup({ budget: 10 });
    const r = g.builtin("grep");
    expect(r.message).toContain("TOOL OUTPUT");
    expect(r.message).toContain("[tool tip 1/3]");
  });

  it("counts the shell and built-in searches separately, so one does not spend the other's tips", async () => {
    const g = await setup({ budget: 10 });
    for (let i = 0; i < 3; i++) g.shell(`rg -n "thing${i}" src/`);
    // The shell ladder is exhausted; the built-in tool still has its own tips.
    expect(g.shell('rg -n "more" src/').allowed).toBe(false);
    expect(g.builtin("grep").allowed).toBe(true);
  });

  it("does not police a built-in name when the call is really a shell command", async () => {
    const g = await setup({ budget: 10 });
    expect(g.shell("git log -n 5").message).not.toContain("tool tip");
  });
});

describe("checkWriteTarget", () => {
  const { checkWriteTarget } = helpers;
  const cwd = "/tmp/code-review-subject-ab63e811be83-1-x";
  const outFile = "scratch/repo-branch-ab63e811be83-20261014174949-s01.json";

  it("allows the write tool to the output file, relative or absolute", () => {
    expect(checkWriteTarget("write", { path: outFile }, outFile, cwd)).toBeNull();
    expect(checkWriteTarget("write", { filePath: path.join(cwd, outFile) }, outFile, cwd)).toBeNull();
  });

  it("refuses a write to any other path and names the right one", () => {
    const refusal = checkWriteTarget("write", { path: "scratch/repo-branch-ab63e81-s01.json" }, outFile, cwd);
    expect(refusal).toContain(outFile);
    expect(checkWriteTarget("edit", { path: "src/index.ts" }, outFile, cwd)).toContain("refused");
  });

  it("refuses patch tools outright", () => {
    expect(checkWriteTarget("apply_patch", { patchText: "..." }, outFile, cwd)).toContain("not available");
  });

  it("leaves other tools and calls without an output file alone", () => {
    expect(checkWriteTarget("read", { path: "src/index.ts" }, outFile, cwd)).toBeNull();
    expect(checkWriteTarget("write", { path: "anything" }, "", cwd)).toBeNull();
  });
});
