import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { subscriptionHome } from "../review/subscription.ts";

const entry = path.resolve(import.meta.dir, "../index.ts");
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "diffloupe-auth-"));
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  const opencode = path.join(bin, "opencode");
  await writeFile(opencode, `#!${process.execPath}
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(process.env.FIXTURE_VERSION ?? "2.0.26");
  process.exit(0);
}
appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({
  args, cwd: process.cwd(), data: process.env.XDG_DATA_HOME,
  database: process.env.OPENCODE_DB, hasApiKey: !!process.env.OPENAI_API_KEY,
}) + "\\n");
if (process.env.FIXTURE_EXIT) process.exit(Number(process.env.FIXTURE_EXIT));
if (process.env.FIXTURE_HANG) {
  const descendant = Bun.spawn([process.execPath, "-e",
    "process.on('SIGTERM', () => { require('node:fs').writeFileSync(process.env.FIXTURE_DESCENDANT_SIGNAL, 'SIGTERM'); process.exit(0); }); process.stdout.write('ready'); setInterval(() => {}, 1000);",
  ], { stdout: "pipe", stderr: "inherit" });
  await descendant.stdout.getReader().read();
  process.on("SIGTERM", async () => {
    writeFileSync(process.env.FIXTURE_SIGNAL, "SIGTERM");
    await descendant.exited;
    process.exit(0);
  });
  writeFileSync(process.env.FIXTURE_READY, "ready");
  setInterval(() => {}, 1000);
} else if (args[1] === "login") {
  const input = await Bun.stdin.text();
  writeFileSync(process.env.FIXTURE_ACCOUNT, input);
  console.log("Signed in with ChatGPT");
} else if (args[1] === "logout") {
  if (existsSync(process.env.FIXTURE_ACCOUNT)) unlinkSync(process.env.FIXTURE_ACCOUNT);
  console.log("Signed out");
} else if (args.includes("json")) {
  console.log(JSON.stringify(existsSync(process.env.FIXTURE_ACCOUNT) ? [{
    id: "openai", connections: [{ type: "credential", id: "cred_fixture", method: process.env.FIXTURE_METHOD ?? "oauth" }],
  }] : []));
} else {
  console.log(existsSync(process.env.FIXTURE_ACCOUNT) ? "OpenAI: ChatGPT" : "No accounts");
}
`);
  await chmod(opencode, 0o755);
  env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    XDG_DATA_HOME: path.join(dir, "data"),
    OPENCODE_DB: path.join(dir, "ordinary-profile.sqlite"),
    OPENAI_API_KEY: "ordinary-profile-api-key",
    FIXTURE_LOG: path.join(dir, "commands.jsonl"),
    FIXTURE_ACCOUNT: path.join(dir, "account"),
    FIXTURE_SIGNAL: path.join(dir, "signal"),
    FIXTURE_DESCENDANT_SIGNAL: path.join(dir, "descendant-signal"),
    FIXTURE_READY: path.join(dir, "ready"),
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}, input = "") {
  const proc = Bun.spawn([process.execPath, "--no-env-file", entry, "auth", ...args], {
    cwd: dir,
    env: { ...env, ...extraEnv },
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("subscription auth CLI", () => {
  test("login prompts, status, and logout use the dedicated profile without importing credentials", async () => {
    const login = await cli(["login", "openai"], {}, "browser approved");
    expect(login.code).toBe(0);
    expect(login.stdout).toContain("Choose a ChatGPT subscription method");
    expect(login.stdout).toContain("Signed in with ChatGPT");
    expect(await readFile(env.FIXTURE_ACCOUNT!, "utf8")).toBe("browser approved");
    expect((await cli(["status"])).stdout).toContain("OpenAI: ChatGPT");
    expect((await cli(["logout"])).code).toBe(0);
    expect((await cli(["status"])).stdout).toContain("No accounts");

    const commands = (await readFile(env.FIXTURE_LOG!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const home = subscriptionHome(env);
    const cwd = await realpath(home);
    expect(commands).toEqual([
      ["auth", "login", "openai", "--standalone"],
      ["auth", "list", "--standalone", "--format", "json"],
      ["auth", "list", "--standalone"],
      ["auth", "logout", "openai", "--standalone"],
      ["auth", "list", "--standalone"],
    ].map((args) => ({
      args,
      cwd,
      data: path.join(home, "data"),
      hasApiKey: false,
    })));
  });

  test("unsupported providers and OpenCode versions fail before authentication", async () => {
    const provider = await cli(["login", "anthropic"]);
    expect(provider.code).not.toBe(0);
    expect(provider.stderr).toContain("supports openai only");
    const version = await cli(["login"], { FIXTURE_VERSION: "1.19.3" });
    expect(version.code).toBe(1);
    expect(version.stderr).toContain("needs OpenCode 2.x");
    expect(await Bun.file(env.FIXTURE_LOG!).exists()).toBe(false);
  });

  test("propagates an authentication failure's exit status", async () => {
    expect((await cli(["login"], { FIXTURE_EXIT: "7" })).code).toBe(7);
    expect((await cli(["status"])).code).toBe(0);
  });

  test("selecting an API key does not report a successful subscription login", async () => {
    const result = await cli(["login"], { FIXTURE_METHOD: "key" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("ChatGPT");
    expect(result.stderr).toContain("diffloupe auth login");
  });

  test("termination stops OpenCode before releasing the profile", async () => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", entry, "auth", "login"], {
      cwd: dir,
      env: { ...env, FIXTURE_HANG: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const interval = setInterval(() => {
          if (!existsSync(env.FIXTURE_READY!)) return;
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }, 10);
        const timeout = setTimeout(() => {
          clearInterval(interval);
          reject(new Error("OpenCode auth fixture did not start"));
        }, 2_000);
      });
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(143);
      expect(await readFile(env.FIXTURE_SIGNAL!, "utf8")).toBe("SIGTERM");
      expect(await readFile(env.FIXTURE_DESCENDANT_SIGNAL!, "utf8")).toBe("SIGTERM");
      expect((await cli(["status"])).code).toBe(0);
    } finally {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await proc.exited;
      }
    }
  });
});
