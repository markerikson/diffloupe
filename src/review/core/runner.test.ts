import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as config from "./config.ts";
import { applyConfig, resetRunState, setRunState } from "./config.ts";
import { agent, answerFromText, killAgents, lastReplyText, liveAgentCount, parseAgentJson, resetOpenCodeConfig } from "./runner.ts";
import type { FakeEvent, FakePlan } from "./test-fixtures/fake-opencode.ts";

describe("parseAgentJson", () => {
  test("escapes raw tabs and newlines inside string values", () => {
    const text = '{\n  "findings": [{ "suggested_code": "\t\tconst a = 1;\n\t\treturn a;", "title": "x \\"q\\"" }]\n}';
    expect(parseAgentJson(text)).toEqual({
      findings: [{ suggested_code: "\t\tconst a = 1;\n\t\treturn a;", title: 'x "q"' }],
    });
  });

  test("escapes unescaped double quotes inside prose", () => {
    const text = '{\n  "findings": [\n    { "evidence": "so "generated code" is fine", "line": 3 }\n  ]\n}';
    expect(parseAgentJson(text)).toEqual({ findings: [{ evidence: 'so "generated code" is fine', line: 3 }] });
  });

  test("still rejects JSON that is broken in other ways", () => {
    expect(() => parseAgentJson('{"findings": [')).toThrow();
  });

  test("reports the original parse error when a repair does not help", () => {
    const text = '{"a": "x\ty", "b": }';
    let original = "";
    try {
      JSON.parse(text);
    } catch (error) {
      original = (error as Error).message;
    }
    expect(() => parseAgentJson(text)).toThrow(original);
  });
});

describe("agent native sessions", () => {
  let tmp: string;
  let events: FakeEvent[];
  let collector: Bun.Server<undefined>;
  let changed: Set<() => void>;
  let savedPath: string | undefined;
  let savedKeepScratch: string | undefined;
  let savedConfig: Parameters<typeof applyConfig>[0];

  function recorded<T extends FakeEvent["type"]>(type: T) {
    return events.filter((event) => event.type === type) as (FakeEvent & { type: T })[];
  }
  function processes(kind: string) {
    return recorded("process").filter((event) => event.kind === kind);
  }
  function children() {
    return recorded("session").filter((event) => event.body.parentID);
  }
  // Notifications originate in the external process. Timeouts only bound a
  // broken test; no scheduling or concurrency assertion depends on a sleep.
  async function observed<T extends FakeEvent["type"]>(
    type: T,
    count = 1,
    predicate: (event: FakeEvent & { type: T }) => boolean = () => true,
  ) {
    const matching = () => recorded(type).filter(predicate);
    if (matching().length >= count) return;
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (matching().length < count) return;
        clearTimeout(timer);
        changed.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        changed.delete(check);
        reject(new Error(`Expected ${count} matching ${type} events, saw ${matching().length}`));
      }, 4000);
      changed.add(check);
      check();
    });
  }
  function usePlan(plan: FakePlan, childEnv: Record<string, string> = {}) {
    applyConfig({ childEnv: {
      FAKE_OPENCODE_EVENTS: collector.url.origin,
      FAKE_OPENCODE_PLAN: JSON.stringify(plan),
      ...childEnv,
    } });
  }
  function options(tag: string, extra: Partial<Parameters<typeof agent>[1]> = {}) {
    return { tag, budget: 1, outFile: path.join(tmp, `${tag}.json`), ...extra };
  }
  function expectClosed() {
    expect(liveAgentCount()).toBe(0);
    for (const event of recorded("process")) {
      expect(() => process.kill(event.pid, 0)).toThrow();
    }
  }

  beforeEach(async () => {
    await killAgents(100);
    resetOpenCodeConfig();
    resetRunState();
    savedConfig = {
      out: config.OUT, artifacts: config.ARTIFACTS, authImport: config.AUTH_IMPORT,
      subscriptionHome: config.SUBSCRIPTION_HOME, childEnv: config.CHILD_ENV,
      deadlineMs: config.DEADLINE_MS, maxSteps: config.MAX_STEPS,
    };
    savedPath = process.env.PATH;
    savedKeepScratch = process.env.DIFFLOUPE_KEEP_SCRATCH;
    delete process.env.DIFFLOUPE_KEEP_SCRATCH;
    tmp = await mkdtemp(path.join(os.tmpdir(), "diffloupe-native-runner-"));
    const bin = path.join(tmp, "bin");
    await mkdir(bin);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const fixture = path.join(import.meta.dir, "test-fixtures", "fake-opencode.ts");
    await writeFile(path.join(bin, "opencode"), `#!/bin/sh\nexec ${quote(process.execPath)} --no-env-file ${quote(fixture)} "$@"\n`);
    await chmod(path.join(bin, "opencode"), 0o755);
    process.env.PATH = `${bin}:${savedPath ?? ""}`;
    await mkdir(path.join(tmp, "artifacts", "logs"), { recursive: true });
    await mkdir(path.join(tmp, "artifacts", "raw"), { recursive: true });
    events = [];
    changed = new Set();
    collector = Bun.serve({ hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/hold") return new Promise<Response>(() => {});
        events.push(await request.json() as FakeEvent);
        for (const check of changed) check();
        return new Response("ok");
      },
    });
    applyConfig({
      out: path.join(tmp, "out"), artifacts: path.join(tmp, "artifacts"),
      authImport: "[]", subscriptionHome: "", maxSteps: 23, deadlineMs: 123_000,
    });
    usePlan({});
    setRunState({ subject: tmp });
  });

  afterEach(async () => {
    // Leave the collector and directory alive until every child and worker closes.
    await killAgents(100);
    resetOpenCodeConfig();
    resetRunState();
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedKeepScratch === undefined) delete process.env.DIFFLOUPE_KEEP_SCRATCH;
    else process.env.DIFFLOUPE_KEEP_SCRATCH = savedKeepScratch;
    applyConfig(savedConfig);
    await collector.stop(true);
    await rm(tmp, { recursive: true, force: true });
  });

  test("subscription children overlap under one unprompted parent and retain independent answers and accounting", async () => {
    const home = path.join(tmp, "subscription");
    applyConfig({ subscriptionHome: home });
    const firstUsage = { costUsd: 0.12, numTurns: 2, usage: {
      input_tokens: 11, output_tokens: 12, reasoning_tokens: 13,
      cache_read_input_tokens: 14, cache_creation_input_tokens: 15,
    } };
    const secondUsage = { costUsd: 0.34, numTurns: 3, usage: {
      input_tokens: 21, output_tokens: 22, reasoning_tokens: 23,
      cache_read_input_tokens: 24, cache_creation_input_tokens: 25,
    } };
    usePlan({ barrier: 2, responses: {
      first: { payload: { findings: ["first"] }, usage: firstUsage },
      second: { payload: { findings: ["second"] }, usage: secondUsage },
    } });
    expect(events).toEqual([]);
    const startedAt = Date.now();
    const results = await Promise.all([
      agent("first diff", options("first", { model: "openai/alpha#high", budget: 0.5, system: { name: "same-name", text: "First instructions" } })),
      agent("second diff", options("second", { model: "openai/beta", effort: "low", budget: 1.5, system: { name: "same-name", text: "Second instructions" } })),
    ]);
    expect(results.map((result) => result.payload)).toEqual([{ findings: ["first"] }, { findings: ["second"] }]);
    expect(results[0]).toMatchObject(firstUsage);
    expect(results[1]).toMatchObject(secondUsage);
    expect(processes("serve")).toHaveLength(1);
    expect(processes("auth-list")).toHaveLength(1);
    expect(processes("auth-import")).toHaveLength(0);
    const parents = recorded("session").filter((event) => !event.body.parentID);
    expect(parents).toHaveLength(1);
    expect(parents[0]!.body).toMatchObject({ agent: "review", metadata: { diffloupeRun: true } });
    const runs = recorded("run-start");
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.id)).not.toContain(parents[0]!.id);
    const firstFinish = events.findIndex((event) => event.type === "run-finish");
    expect(events.slice(0, firstFinish).filter((event) => event.type === "run-start")).toHaveLength(2);
    const sessions = children();
    expect(sessions).toHaveLength(2);
    const cwd = await realpath(tmp);
    const logs = await Promise.all(sessions.map(async (session) =>
      JSON.parse(await readFile(session.body.metadata.diffloupe!.logFile, "utf8")) as unknown));
    for (const [tag, prompt, model, budget] of [
      ["first", "first diff", { providerID: "openai", id: "alpha", variant: "high" }, 0.5],
      ["second", "second diff", { providerID: "openai", id: "beta", variant: "low" }, 1.5],
    ] as const) {
      const child = sessions.find((session) => session.body.title === tag)!;
      expect(child.body).toMatchObject({ parentID: parents[0]!.id, agent: "reviewer", model });
      const metadata = child.body.metadata.diffloupe!;
      expect(metadata).toMatchObject({
        version: 1, runID: parents[0]!.id, tag, budgetUsd: budget, maxSteps: 23, deadlineMs: 123_000,
        outFile: path.join(tmp, `${tag}.json`), usageFile: path.join(tmp, "artifacts", "logs", `${tag}.usage.json`),
        logFile: path.join(tmp, "artifacts", "logs", `${tag}.governor.jsonl`), tools: "repo", waitForTools: "tilth_",
      });
      expect(metadata.startedAt).toBeGreaterThanOrEqual(startedAt);
      expect(metadata.startedAt).toBeLessThanOrEqual(Date.now());
      expect(metadata.system).toStartWith(tag === "first" ? "First instructions" : "Second instructions");
      expect(metadata.expectTools).toContain("tilth_tilth_read");
      expect(runs.find((run) => run.id === child.id)!.prompt).toBe(prompt);
      expect(logs).toContainEqual({ sessionID: child.id, tag });
      const cli = processes("run").find((event) => event.args.includes(child.id))!;
      expect(cli.args).toEqual(["run", "--server", recorded("listening")[0]!.url, "--session", child.id, "--format", "json"]);
      expect(cli.cwd).toBe(cwd);
      expect(cli.env.PWD).toBe(tmp);
      expect(cli.env.OPENCODE_PASSWORD).toBe(processes("serve")[0]!.env.OPENCODE_PASSWORD);
    }
    const serving = processes("serve")[0]!;
    expect(serving.args).toEqual(["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"]);
    expect(serving.env.PWD).toBe(tmp);
    expect(serving.env.OPENCODE_PASSWORD!.length).toBeGreaterThanOrEqual(32);
    expect(serving.env.XDG_DATA_HOME).toBe(path.join(home, "data"));
    expect(existsSync(path.join(tmp, "out", "oc", "shared"))).toBe(true);
    const lock = new Database(path.join(home, "lock.sqlite"));
    try {
      lock.run("PRAGMA busy_timeout = 0");
      expect(() => lock.run("BEGIN IMMEDIATE")).toThrow();
      await killAgents(100);
      // Shutdown has closed the worker too, so a new review can own the profile.
      lock.run("BEGIN IMMEDIATE");
      lock.run("ROLLBACK");
    } finally { lock.close(true); }
    expectClosed();
    expect(existsSync(path.join(tmp, "out", "oc", "shared"))).toBe(false);
    expect(await readFile(path.join(home, "data", "refreshed"), "utf8")).toBe("retained refresh");
  });

  test("mixed credentials use separate servers and import saved keys once only into disposable API data", async () => {
    const home = path.join(tmp, "subscription");
    const authImport = '[{"provider":"anthropic","key":"synthetic-test-key"}]';
    applyConfig({ subscriptionHome: home, authImport });
    usePlan({ barrier: 2 }, {
      OPENCODE_DB: "unrelated-user-database", OPENAI_API_KEY: "synthetic-ambient-key",
      OPENCODE_CONFIG: "/unrelated/config", OPENCODE_CONFIG_CONTENT: "ambient config",
      OPENCODE_CLI_CONFIG_CONTENT: "ambient CLI config", REVIEW_GOVERNOR_OUT_FILE: "/unrelated/output",
    });
    await Promise.all([
      agent("api one", options("api-one", { model: "anthropic/alpha" })),
      agent("subscription one", options("sub-one", { model: "openai/alpha" })),
      agent("api two", options("api-two", { model: "anthropic/beta" })),
      agent("subscription two", options("sub-two", { model: "openai/beta" })),
    ]);
    expect(processes("serve")).toHaveLength(2);
    expect(processes("auth-list")).toHaveLength(1);
    expect(recorded("import").map((event) => event.input)).toEqual([authImport]);
    const servers = processes("serve");
    const subscription = servers.find((event) => event.env.XDG_DATA_HOME === path.join(home, "data"))!;
    const api = servers.find((event) => event !== subscription)!;
    expect(api.env.XDG_DATA_HOME).not.toBe(subscription.env.XDG_DATA_HOME);
    expect(processes("auth-import")[0]!.env.XDG_DATA_HOME).toBe(api.env.XDG_DATA_HOME);
    expect(subscription.env.OPENAI_API_KEY).toBeUndefined();
    expect(api.env.OPENAI_API_KEY).toBe("synthetic-ambient-key");
    expect(api.env.OPENCODE_PASSWORD).not.toBe(subscription.env.OPENCODE_PASSWORD);
    for (const server of servers) {
      expect(server.env.OPENCODE_DB).toBeUndefined();
      expect(server.env.OPENCODE_CONFIG).toBeUndefined();
      expect(server.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      expect(server.env.OPENCODE_CLI_CONFIG_CONTENT).toBeUndefined();
      expect(server.env.REVIEW_GOVERNOR_OUT_FILE).toBeUndefined();
      expect(server.env.REVIEW_GOVERNOR_SESSIONS).toBe("1");
      expect(server.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
      const own = recorded("session").filter((event) => event.pid === server.pid);
      const parent = own.filter((event) => !event.body.parentID);
      expect(parent).toHaveLength(1);
      expect(own.filter((event) => event.body.parentID).map((event) => event.body.parentID)).toEqual([parent[0]!.id, parent[0]!.id]);
    }
    expect(existsSync(api.env.XDG_DATA_HOME!)).toBe(true);
    await killAgents(100);
    expectClosed();
    expect(existsSync(api.env.XDG_DATA_HOME!)).toBe(false);
    expect(existsSync(api.env.XDG_STATE_HOME!)).toBe(false);
    expect(existsSync(subscription.env.XDG_DATA_HOME!)).toBe(true);
  });

  test("no-tools intent and repository review keep distinct instructions and complete permissions on a shared server", async () => {
    usePlan({ barrier: 2 });
    await Promise.all([
      agent("intent input", options("intent", { tools: "none", system: { name: "shared-name", text: "Summarize supplied text only" } })),
      agent("review input", options("review", { system: { name: "shared-name", text: "Investigate changed code" } })),
    ]);
    const intent = children().find((event) => event.body.title === "intent")!.body;
    const review = children().find((event) => event.body.title === "review")!.body;
    expect(intent.parentID).toBe(review.parentID);
    expect(intent.metadata.diffloupe).toMatchObject({
      tools: "none", system: "Summarize supplied text only", waitForTools: "", expectTools: [],
    });
    expect(review.metadata.diffloupe!.system).toStartWith("Investigate changed code");
    expect(review.metadata.diffloupe!.system).not.toContain("Summarize supplied text only");
    expect(review.metadata.diffloupe!.waitForTools).toBe("tilth_");
    expect(intent.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "allow" },
    ]);
    expect(review.permissions).toContainEqual({ action: "*", resource: "*", effect: "deny" });
    expect(review.permissions).toContainEqual({ action: "tilth_*", resource: "*", effect: "allow" });
    expect(processes("serve")).toHaveLength(1);
  });

  test("a failed attached client interrupts and waits for only its own session, then a sibling can succeed", async () => {
    usePlan({ responses: { failed: { exitCode: 7 } } });
    const failed = await agent("failed diff", options("failed"));
    expect(failed.exitCode).toBe(7);
    expect(failed.failure?.kind).toBe("exit");
    const failedID = children()[0]!.id;
    const cleanup = events.filter((event) => event.type === "interrupt" || event.type === "wait");
    expect(cleanup).toEqual([
      { type: "interrupt", pid: processes("serve")[0]!.pid, id: failedID, search: "?resume=false" },
      { type: "wait", pid: processes("serve")[0]!.pid, id: failedID, search: "" },
    ]);
    expect((await agent("healthy diff", options("healthy"))).payload).toEqual({});
    expect(processes("serve")).toHaveLength(1);
    expect(children()).toHaveLength(2);
    expect(liveAgentCount()).toBe(0);
  });

  test("failed credential import prevents server startup and shutdown removes its disposable data", async () => {
    usePlan({ importFailure: true });
    await expect(agent("prompt", options("import-failure"))).rejects.toThrow("opencode auth import failed");
    expect(processes("serve")).toHaveLength(0);
    const data = processes("auth-import")[0]!.env.XDG_DATA_HOME!;
    await killAgents(100);
    expectClosed();
    expect(existsSync(data)).toBe(false);
  });

  test("a missing subscription login cannot start a server or fall back to imported API credentials", async () => {
    const home = path.join(tmp, "subscription");
    applyConfig({ subscriptionHome: home });
    usePlan({ invalidLogin: true });
    await expect(agent("prompt", options("invalid-login", { model: "openai/alpha" }))).rejects.toThrow();
    await killAgents(100);
    expect(processes("auth-list")).toHaveLength(1);
    expect(processes("auth-import")).toHaveLength(0);
    expect(processes("serve")).toHaveLength(0);
    expect(existsSync(path.join(home, "data"))).toBe(true);
    expectClosed();
  });

  test("server startup failure drains concurrent callers without spawning attached clients", async () => {
    usePlan({ startup: "fail" });
    const results = await Promise.allSettled([
      agent("first", options("first")), agent("second", options("second")),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(processes("serve")).toHaveLength(1);
    expect(processes("run")).toHaveLength(0);
    await killAgents(100);
    expectClosed();
    expect(existsSync(path.join(tmp, "out", "oc", "shared"))).toBe(false);
  });

  test.each(["parent", "child"] as const)("a failed %s creation leaves no CLI and shuts down cleanly", async (sessionFailure) => {
    usePlan({ sessionFailure });
    await expect(agent("prompt", options("session-failure"))).rejects.toThrow("HTTP 503");
    expect(processes("run")).toHaveLength(0);
    await killAgents(100);
    expectClosed();
    expect(existsSync(path.join(tmp, "out", "oc", "shared"))).toBe(false);
  });

  test("cancellation while the server is starting closes startup and settles every waiting agent", async () => {
    usePlan({ startup: "hold" });
    const controller = new AbortController();
    setRunState({ signal: controller.signal });
    let settled = 0;
    const pending = ["one", "two"].map((tag) => agent(tag, options(tag)).then(
      () => { settled++; return "resolved"; }, (error: Error) => { settled++; return error.name; },
    ));
    // Auth import also emits a process event; wait specifically for serve.
    await observed("process", 1, (event) => event.kind === "serve");
    controller.abort();
    await killAgents(100);
    expect(settled).toBe(2);
    expect(await Promise.all(pending)).toEqual(["CancelledError", "CancelledError"]);
    expect(processes("run")).toHaveLength(0);
    expectClosed();
    expect(existsSync(path.join(tmp, "out", "oc", "shared"))).toBe(false);
  });

  test.each(["parent", "child"] as const)("cancellation drains an outstanding %s creation before removing scratch data", async (sessionHold) => {
    usePlan({ sessionHold });
    let settled = false;
    const pending = agent("prompt", options("cancel-create")).then(
      () => { settled = true; return "resolved"; }, (error: Error) => { settled = true; return error.name; },
    );
    await observed("session", sessionHold === "parent" ? 1 : 2);
    await killAgents(100);
    expect(settled).toBe(true);
    expect(await pending).toBe("CancelledError");
    expect(processes("run")).toHaveLength(0);
    expectClosed();
    expect(existsSync(path.join(tmp, "out", "oc", "shared"))).toBe(false);
  });

  test("cancellation drains an unfinished saved-key import before removing its data", async () => {
    usePlan({ importHold: true });
    let settled = false;
    const pending = agent("prompt", options("cancel-import")).then(
      () => { settled = true; return "resolved"; }, (error: Error) => { settled = true; return error.name; },
    );
    await observed("import");
    await killAgents(100);
    expect(settled).toBe(true);
    expect(await pending).toBe("CancelledError");
    expect(processes("serve")).toHaveLength(0);
    expectClosed();
    expect(existsSync(path.join(tmp, "out", "oc", "shared"))).toBe(false);
  });

  test("killAgents drains active subscription clients and their server before releasing the profile", async () => {
    const home = path.join(tmp, "subscription");
    applyConfig({ subscriptionHome: home });
    usePlan({ barrier: 2, responses: { one: { hold: true }, two: { hold: true } } });
    let settled = 0;
    const pending = ["one", "two"].map((tag) => agent(tag, options(tag, { model: "openai/alpha" })).then(
      () => { settled++; return "resolved"; }, (error: Error) => { settled++; return error.name; },
    ));
    await observed("run-start", 2);
    expect(liveAgentCount()).toBe(2);
    await killAgents(100);
    expect(settled).toBe(2);
    expect(await Promise.all(pending)).toEqual(["CancelledError", "CancelledError"]);
    expectClosed();
    expect(existsSync(path.join(tmp, "out", "oc", "shared"))).toBe(false);
    expect(await readFile(path.join(home, "data", "refreshed"), "utf8")).toBe("retained refresh");
    const lock = new Database(path.join(home, "lock.sqlite"));
    try { lock.run("BEGIN IMMEDIATE"); } finally { lock.close(true); }
  });

  test("an early stdin failure waits for the client to close and interrupts its session", async () => {
    usePlan({ closeInput: true });
    const result = await agent("x".repeat(1_000_000), options("closed-stdin"));
    expect(result.exitCode).not.toBe(0);
    expect(result.payload).toBeNull();
    expect(result.failure).toBeDefined();
    expect(liveAgentCount()).toBe(0);
    expect(() => process.kill(processes("run")[0]!.pid, 0)).toThrow();
    expect(recorded("interrupt")[0]!.id).toBe(children()[0]!.id);
    expect(recorded("wait")[0]!.id).toBe(children()[0]!.id);
  });

  test("reads the answer from the final reply when no output file is written", async () => {
    usePlan({ responses: { fallback: { reply: 'Here is the draft:\n```json\n{"title": "T", "goal": "G"}\n```' } } });
    const outFile = path.join(tmp, "fallback.json");
    const result = await agent("prompt", options("fallback", { outFile, answerKeys: ["title", "goal"] }));
    expect(result.payload).toEqual({ title: "T", goal: "G" });
    expect(result.failure).toBeUndefined();
    expect(result.deliveredAs).toBe("text");
    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual({ title: "T", goal: "G" });
  });

  test("still reports no output when the reply holds no answer", async () => {
    usePlan({ responses: { missing: { reply: "I ran out of steps." } } });
    const result = await agent("prompt", options("missing", { answerKeys: ["findings"] }));
    expect(result.payload).toBeNull();
    expect(result.failure?.kind).toBe("no-output");
    expect(result.deliveredAs).toBeUndefined();
  });

  test("does not read the reply for a caller that names no answer keys", async () => {
    usePlan({ responses: { unrequested: { reply: '```json\n{"title": "T"}\n```' } } });
    const result = await agent("prompt", options("unrequested"));
    expect(result.payload).toBeNull();
    expect(result.failure?.kind).toBe("no-output");
  });
});

describe("answerFromText", () => {
  test("takes the last fenced block that has an answer key", () => {
    const text = 'First try:\n```json\n{"findings": [1]}\n```\nCorrected:\n```json\n{"findings": [2]}\n```';
    expect(answerFromText(text, ["findings"])).toEqual({ findings: [2] });
  });

  test("falls back to the outermost braces when there is no fence", () => {
    expect(answerFromText('Result: {"keep": [], "resolved": []} done', ["keep"])).toEqual({ keep: [], resolved: [] });
  });

  test("ignores JSON without any answer key", () => {
    expect(answerFromText('See `package.json`:\n```json\n{"type": "module"}\n```', ["findings"])).toBeUndefined();
  });

  test("repairs raw newlines the way the output file parse does", () => {
    expect(answerFromText('```\n{"title": "a\nb", "goal": "g"}\n```', ["title"])).toEqual({ title: "a\nb", goal: "g" });
  });
});

describe("lastReplyText", () => {
  test("returns the last non-empty text part", () => {
    const stream = [
      JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "first" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "  " } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "second" } }),
    ].join("\n");
    expect(lastReplyText(stream)).toBe("second");
  });
});
