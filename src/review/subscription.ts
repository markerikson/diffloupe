import { Database, SQLiteError } from "bun:sqlite";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A lock-owning worker outlives DiffLoupe if its parent exits unexpectedly. */
export function subscriptionCommand(
  home: string,
  args: string[],
  mode: "manage" | "login" | "review" | "probe" = "manage",
): { command: string; args: string[] } {
  const source = path.join(import.meta.dir, "subscription-worker.ts");
  const worker = existsSync(source) ? source : path.join(import.meta.dir, "subscription-worker.js");
  return { command: process.execPath, args: ["--no-env-file", worker, home, mode, ...args] };
}

/** Auth-list metadata only: malformed responses must never trigger an API-key fallback. */
export function hasSubscriptionLogin(stdout: string): boolean {
  const integrations: unknown = JSON.parse(stdout);
  if (!Array.isArray(integrations)) throw new Error("Invalid OpenCode account metadata");
  const entries = integrations.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("id" in entry) || typeof entry.id !== "string" ||
      !("connections" in entry) || !Array.isArray(entry.connections)) {
      throw new Error("Invalid OpenCode account metadata");
    }
    return { id: entry.id, connections: entry.connections };
  });
  const openai = entries.find((entry) => entry.id === "openai");
  if (!openai) return false;
  const active: unknown = openai.connections[0];
  if (active === undefined) return false;
  if (typeof active !== "object" || active === null || !("type" in active)) {
    throw new Error("Invalid OpenCode account metadata");
  }
  if (active.type !== "credential") return false;
  if (!("method" in active) || typeof active.method !== "string") {
    throw new Error("Invalid OpenCode account metadata");
  }
  return active.method === "oauth";
}

/** A separate OpenCode login keeps subscription refreshes out of the user's own profile. */
export function subscriptionHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "diffloupe", "subscription", "openai");
}

/** Environment for every command that reads or changes the subscription login. */
export function subscriptionEnv(home: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...env,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "xdg"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    OPENCODE_CONFIG_DIR: path.join(home, "config"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
  for (const key of ["OPENCODE_DB", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CLI_CONFIG_CONTENT", "OPENAI_API_KEY"]) {
    delete result[key];
  }
  return result;
}

async function waitForLock(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 100);
    signal?.addEventListener("abort", finish, { once: true });
  });
  signal?.throwIfAborted();
}

/**
 * Serialize profile access across DiffLoupe processes. An immediate SQLite
 * transaction owns the lock until the action finishes; a crashed process loses
 * it automatically. The database contains no credentials or application data.
 *
 * Cancellation stops waiting for the lock. Once started, the action must stop
 * its own child processes before settling so they cannot outlive this lock.
 */
export async function withSubscriptionProfile<T>(
  home: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await Promise.all(["data", "config", "xdg", "state", "cache"].map(async (name) => {
    const dir = path.join(home, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }));
  signal?.throwIfAborted();
  const lockFile = path.join(home, "lock.sqlite");
  const db = new Database(lockFile);
  try {
    await chmod(lockFile, 0o600);
    // Never block Bun's event loop: another invocation in this process may
    // hold the lock while awaiting its OpenCode subprocess.
    db.run("PRAGMA busy_timeout = 0");
    while (true) {
      signal?.throwIfAborted();
      try {
        db.run("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!(error instanceof SQLiteError) || error.code !== "SQLITE_BUSY") throw error;
        // eslint-disable-next-line no-await-in-loop -- Retrying must wait for the current owner without blocking Bun.
        await waitForLock(signal);
      }
    }
    signal?.throwIfAborted();
    return await action();
  } finally {
    // Closing rolls back the empty transaction, also when action() rejects.
    db.close(true);
  }
}
