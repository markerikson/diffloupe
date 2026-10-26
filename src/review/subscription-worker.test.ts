import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hasSubscriptionLogin, subscriptionCommand, subscriptionEnv, withSubscriptionProfile } from "./subscription.ts";

let tmp: string;
let home: string;
let env: NodeJS.ProcessEnv;

type NativeEvent = { label: string; event: string; args?: string[]; cwd?: string; config?: string };

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "diffloupe-subscription-worker-"));
  home = path.join(tmp, "profile");
  const bin = path.join(tmp, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "opencode"), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const record = (event) => appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({
  label: process.env.FIXTURE_LABEL, event, args, cwd: process.cwd(), config: process.env.OPENCODE_CONFIG_DIR,
}) + "\\n");
record("start");
if (args[0] === "auth" && args[1] === "list") {
  const kind = readFileSync(process.env.FIXTURE_ACCOUNT, "utf8");
  console.log(JSON.stringify([{ id: "openai", connections: kind === "none" ? [] : [{ type: "credential", method: kind }] }]));
} else if (args[0] === "auth" && args[1] === "login") {
  writeFileSync(process.env.FIXTURE_ACCOUNT, process.env.FIXTURE_LOGIN_KIND ?? "oauth");
} else if (process.env.FIXTURE_HOLD === "1") {
  writeFileSync(process.env.FIXTURE_READY, String(process.pid));
  const timeout = setTimeout(() => process.exit(2), 8_000);
  const interval = setInterval(() => {
    if (!existsSync(process.env.FIXTURE_RELEASE)) return;
    record("finish");
    clearInterval(interval);
    clearTimeout(timeout);
  }, 10);
  process.on("SIGTERM", () => {
    clearInterval(interval);
    clearTimeout(timeout);
    setTimeout(() => { record("terminated"); process.exit(0); }, 100);
  });
} else {
  console.log("review complete");
}
`);
  await chmod(path.join(bin, "opencode"), 0o755);
  env = subscriptionEnv(home, {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FIXTURE_EVENTS: path.join(tmp, "events.jsonl"),
    FIXTURE_ACCOUNT: path.join(tmp, "account"),
    FIXTURE_READY: path.join(tmp, "ready"),
    FIXTURE_RELEASE: path.join(tmp, "release"),
    FIXTURE_LABEL: "first",
  });
  await writeFile(env.FIXTURE_ACCOUNT!, "oauth");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function worker(
  mode: "review" | "manage" | "login" = "review",
  overrides: NodeJS.ProcessEnv = {},
  args = mode === "review" ? ["run", "--standalone"] : ["auth", mode === "login" ? "login" : "list", "--standalone"],
) {
  const command = subscriptionCommand(home, args, mode);
  return Bun.spawn([command.command, ...command.args], {
    cwd: tmp, env: { ...env, ...overrides }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
}

async function events(): Promise<NativeEvent[]> {
  if (!existsSync(env.FIXTURE_EVENTS!)) return [];
  return (await readFile(env.FIXTURE_EVENTS!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

async function waitForFile(file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const interval = setInterval(() => {
      if (!existsSync(file)) return;
      clearInterval(interval);
      clearTimeout(timeout);
      resolve();
    }, 10);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Fixture did not create ${path.basename(file)}`));
    }, 3_000);
  });
}

describe("subscription worker", () => {
  test("checks active OAuth under the lock and preserves the review environment", async () => {
    const config = path.join(tmp, "review-config");
    const child = worker("review", { OPENCODE_CONFIG_DIR: config });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("review complete\n");
    const commands = await events();
    expect(commands.map((event) => event.args)).toEqual([
      ["auth", "list", "--standalone", "--format", "json"], ["run", "--standalone"],
    ]);
    expect(commands.every((event) => event.config === config)).toBe(true);
    const cwd = await realpath(tmp);
    expect(commands.every((event) => event.cwd === cwd)).toBe(true);
  });

  test("announces stdio profile phases around acquisition", async () => {
    let child: ReturnType<typeof worker> | undefined;
    try {
      await withSubscriptionProfile(home, async () => {
        child = worker("review", {}, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"]);
        const reader = child.stdout.getReader();
        const timeout = setTimeout(() => child!.kill("SIGKILL"), 3_000);
        try {
          let firstLine = "";
          const decoder = new TextDecoder();
          while (!firstLine.includes("\n")) {
            // eslint-disable-next-line no-await-in-loop -- A pipe may split a line across several reads.
            const chunk = await reader.read();
            if (chunk.done) throw new Error("Worker exited before announcing its profile wait");
            firstLine += decoder.decode(chunk.value, { stream: true });
          }
          expect(firstLine).toBe('{"diffloupe":"waiting-for-profile"}\n');
          expect(await events()).toEqual([]);
        } finally {
          clearTimeout(timeout);
          reader.releaseLock();
        }
      });
      expect(await child!.exited).toBe(0);
      let remaining = "";
      for await (const chunk of child!.stdout) remaining += new TextDecoder().decode(chunk);
      expect(remaining).toBe('{"diffloupe":"profile-acquired"}\nreview complete\n');
      expect((await events()).map((event) => event.args?.[0])).toEqual(["auth", "serve"]);
    } finally {
      if (child?.exitCode === null) child.kill("SIGKILL");
      await child?.exited;
    }
  });

  test("refuses to run when the profile has changed to an API key", async () => {
    await writeFile(env.FIXTURE_ACCOUNT!, "key");
    const child = worker("review", {}, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"]);
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stdout).text()).toBe('{"diffloupe":"waiting-for-profile"}\n{"diffloupe":"profile-acquired"}\n');
    expect(await new Response(child.stderr).text()).toContain("diffloupe auth login");
    expect((await events()).map((event) => event.args?.[0])).toEqual(["auth"]);
  });

  test("rejects an API-key login and runs account commands inside the profile", async () => {
    const child = worker("login", { FIXTURE_LOGIN_KIND: "key" });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("Choose a ChatGPT subscription method");
    const commands = await events();
    expect(commands.map((event) => event.args?.[1])).toEqual(["login", "list"]);
    const cwd = await realpath(home);
    expect(commands.every((event) => event.cwd === cwd)).toBe(true);
  });

  test("cancelling a waiting worker never launches OpenCode", async () => {
    await withSubscriptionProfile(home, async () => {
      const child = worker();
      try {
        await Bun.sleep(150);
        child.kill("SIGTERM");
        expect(await child.exited).toBe(143);
        expect(await events()).toEqual([]);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    });
    expect(await worker().exited).toBe(0);
  });

  test("termination waits for OpenCode to close before another worker can use the profile", async () => {
    const first = worker("review", { FIXTURE_HOLD: "1" });
    let second: ReturnType<typeof worker> | undefined;
    try {
      await waitForFile(env.FIXTURE_READY!);
      first.kill("SIGTERM");
      second = worker("review", { FIXTURE_LABEL: "second" });
      expect(await first.exited).toBe(143);
      expect(await second.exited).toBe(0);
      const order = (await events()).map((event) => `${event.label}:${event.event}`);
      expect(order).toContain("first:terminated");
      expect(order.indexOf("first:terminated")).toBeLessThan(order.indexOf("second:start"));
    } finally {
      if (first.exitCode === null) first.kill("SIGTERM");
      if (second?.exitCode === null) second.kill("SIGTERM");
      await first.exited;
      await second?.exited;
    }
  });

  test("a killed DiffLoupe parent leaves the worker holding the lock until OpenCode exits", async () => {
    const moduleURL = pathToFileURL(path.join(import.meta.dir, "subscription.ts")).href;
    const workerPIDFile = path.join(tmp, "worker-pid");
    const parent = Bun.spawn([process.execPath, "--eval", `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { subscriptionCommand } from ${JSON.stringify(moduleURL)};
      const command = subscriptionCommand(${JSON.stringify(home)}, ["run", "--standalone"], "review");
      const worker = spawn(command.command, command.args, { detached: true, stdio: "ignore" });
      writeFileSync(${JSON.stringify(workerPIDFile)}, String(worker.pid));
      setInterval(() => {}, 1_000);
    `], { cwd: tmp, env: { ...env, FIXTURE_HOLD: "1" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let second: ReturnType<typeof worker> | undefined;
    let workerPID: number | undefined;
    try {
      await waitForFile(env.FIXTURE_READY!);
      workerPID = Number(await readFile(workerPIDFile, "utf8"));
      parent.kill("SIGKILL");
      await parent.exited;
      second = worker("review", { FIXTURE_LABEL: "second" });
      await Bun.sleep(150);
      expect((await events()).every((event) => event.label === "first")).toBe(true);
      await writeFile(env.FIXTURE_RELEASE!, "release");
      expect(await second.exited).toBe(0);
      const order = (await events()).map((event) => `${event.label}:${event.event}`);
      expect(order).toContain("first:finish");
      expect(order.indexOf("first:finish")).toBeLessThan(order.indexOf("second:start"));
    } finally {
      if (parent.exitCode === null) parent.kill("SIGKILL");
      await parent.exited;
      await writeFile(env.FIXTURE_RELEASE!, "release");
      if (workerPID !== undefined) {
        try { process.kill(-workerPID, "SIGTERM"); } catch { /* Already finished. */ }
      }
      if (second?.exitCode === null) second.kill("SIGTERM");
      await second?.exited;
    }
  }, 10_000);
});

test("subscription metadata rejects malformed responses and ignores inactive OAuth connections", () => {
  expect(hasSubscriptionLogin(JSON.stringify([{ id: "openai", connections: [{ type: "credential", method: "oauth" }] }]))).toBe(true);
  expect(hasSubscriptionLogin(JSON.stringify([{ id: "openai", connections: [
    { type: "credential", method: "key" }, { type: "credential", method: "oauth" },
  ] }]))).toBe(false);
  expect(hasSubscriptionLogin("[]")).toBe(false);
  expect(() => hasSubscriptionLogin("not json")).toThrow();
  expect(() => hasSubscriptionLogin("{}")).toThrow("Invalid OpenCode account metadata");
  expect(() => hasSubscriptionLogin("[null]")).toThrow("Invalid OpenCode account metadata");
  expect(() => hasSubscriptionLogin('[{"id":"openai"}]')).toThrow("Invalid OpenCode account metadata");
});
