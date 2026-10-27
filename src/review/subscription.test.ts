import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { subscriptionEnv, subscriptionHome, withSubscriptionProfile } from "./subscription.ts";

let tmp: string;
let home: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "diffloupe-subscription-"));
  home = path.join(tmp, "profile");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function gate() {
  let open = () => {};
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

describe("subscription profile environment", () => {
  test("uses the user's data directory with an absolute fallback", () => {
    expect(subscriptionHome({ XDG_DATA_HOME: tmp })).toBe(path.join(tmp, "diffloupe", "subscription", "openai"));
    expect(subscriptionHome({})).toBe(path.join(os.homedir(), ".local", "share", "diffloupe", "subscription", "openai"));
    expect(path.isAbsolute(subscriptionHome({ XDG_DATA_HOME: "relative-data" }))).toBe(true);
  });

  test("isolates OpenCode configuration and credentials without changing the parent environment", () => {
    const inherited = {
      PATH: "/bin",
      OPENAI_API_KEY: "synthetic-key",
      ANTHROPIC_API_KEY: "other-provider-key",
      XDG_DATA_HOME: "/old/data",
      XDG_CONFIG_HOME: "/old/config",
      XDG_STATE_HOME: "/old/state",
      XDG_CACHE_HOME: "/old/cache",
      OPENCODE_CONFIG_DIR: "/old/overrides",
      OPENCODE_DB: "/old/opencode.db",
      OPENCODE_CONFIG: "/old/opencode.json",
      OPENCODE_CONFIG_CONTENT: "old config",
      OPENCODE_CLI_CONFIG_CONTENT: "old CLI config",
      OPENCODE_DISABLE_PROJECT_CONFIG: "0",
      OPENCODE_DISABLE_AUTOUPDATE: "0",
    };
    expect(subscriptionEnv(home, inherited)).toEqual({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "other-provider-key",
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "xdg"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      OPENCODE_CONFIG_DIR: path.join(home, "config"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    });
    expect(inherited.OPENAI_API_KEY).toBe("synthetic-key");
    expect(inherited.OPENCODE_DB).toBe("/old/opencode.db");
  });
});

describe("withSubscriptionProfile", () => {
  test("serializes concurrent callbacks and restricts profile permissions", async () => {
    const started = gate();
    const release = gate();
    const events: string[] = [];
    const first = withSubscriptionProfile(home, async () => {
      events.push("first starts");
      started.open();
      await release.wait;
      events.push("first ends");
      return "first result";
    });
    await started.wait;
    const second = withSubscriptionProfile(home, async () => {
      events.push("second starts");
      return "second result";
    });
    try {
      await Bun.sleep(150);
      expect(events).toEqual(["first starts"]);
    } finally {
      release.open();
    }
    expect(await Promise.all([first, second])).toEqual(["first result", "second result"]);
    expect(events).toEqual(["first starts", "first ends", "second starts"]);
    const dirs = [home, ...["data", "config", "xdg", "state", "cache"].map((name) => path.join(home, name))];
    for (const info of await Promise.all(dirs.map((dir) => stat(dir)))) {
      expect(info.mode & 0o777).toBe(0o700);
    }
    expect((await stat(path.join(home, "lock.sqlite"))).mode & 0o777).toBe(0o600);
  });

  test("releases the profile when the callback fails", async () => {
    const failure = new Error("login failed");
    await expect(withSubscriptionProfile(home, async () => { throw failure; })).rejects.toBe(failure);
    expect(await withSubscriptionProfile(home, async () => "retried", AbortSignal.timeout(1_000))).toBe("retried");
  });

  test("a cancelled waiter never starts its callback or prevents later access", async () => {
    const started = gate();
    const release = gate();
    const holder = withSubscriptionProfile(home, async () => {
      started.open();
      await release.wait;
    });
    await started.wait;
    const controller = new AbortController();
    const reason = new Error("review cancelled");
    let called = false;
    const waiter = withSubscriptionProfile(home, async () => { called = true; }, controller.signal);
    try {
      await Bun.sleep(150);
      controller.abort(reason);
      await expect(waiter).rejects.toBe(reason);
      expect(called).toBe(false);
    } finally {
      release.open();
      await holder;
    }
    expect(await withSubscriptionProfile(home, async () => "next review", AbortSignal.timeout(1_000))).toBe("next review");
  });

  test("does not create a profile for an already cancelled operation", async () => {
    const reason = new Error("cancelled before start");
    let called = false;
    await expect(withSubscriptionProfile(home, async () => { called = true; }, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(called).toBe(false);
    expect(existsSync(home)).toBe(false);
  });

  test("waits for another process and recovers its lock after a crash", async () => {
    const moduleURL = pathToFileURL(path.join(import.meta.dir, "subscription.ts")).href;
    const child = Bun.spawn([process.execPath, "--eval", `
      import { withSubscriptionProfile } from ${JSON.stringify(moduleURL)};
      await withSubscriptionProfile(${JSON.stringify(home)}, async () => {
        console.log("locked");
        await new Promise(() => setTimeout(() => process.exit(2), 5_000));
      });
    `], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let pending: Promise<string> | undefined;
    try {
      const ready = await child.stdout.getReader().read();
      expect(new TextDecoder().decode(ready.value)).toContain("locked");
      let called = false;
      pending = withSubscriptionProfile(home, async () => {
        called = true;
        return "recovered";
      }, AbortSignal.timeout(3_000));
      await Bun.sleep(150);
      expect(called).toBe(false);
      child.kill("SIGKILL");
      await child.exited;
      expect(await pending).toBe("recovered");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      await pending?.catch(() => {});
    }
  }, 10_000);
});
