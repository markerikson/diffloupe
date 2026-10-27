/**
 * Own the subscription lock for the OpenCode command's lifetime. During a
 * review this is one server with concurrent child sessions. Its --stdio lease
 * closes when DiffLoupe exits; wait for that server before unlocking the profile.
 */
import { spawn } from "node:child_process";
import { hasSubscriptionLogin, withSubscriptionProfile } from "./subscription.ts";

function openCode(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  capture = false,
): Promise<{ code: number; stdout: string }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", args, { cwd, stdio: capture ? ["ignore", "pipe", "ignore"] : "inherit" });
    const output: Buffer[] = [];
    child.stdout?.on("data", (data: Buffer) => output.push(data));
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill(signal.reason === "SIGINT" ? "SIGINT" : "SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("error", (error) => { failure = error; });
    child.once("close", (code, killedBy) => {
      signal.removeEventListener("abort", abort);
      clearTimeout(killTimer);
      if (failure) {
        reject(new Error("Could not start OpenCode. Check that opencode is installed and on PATH."));
        return;
      }
      resolve({
        code: code ?? (killedBy === "SIGINT" ? 130 : killedBy === "SIGTERM" ? 143 : 1),
        stdout: Buffer.concat(output).toString("utf8"),
      });
    });
  });
}

async function requireSubscription(cwd: string, signal: AbortSignal, afterLogin = false): Promise<void> {
  const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const result = await openCode(["auth", "list", "--standalone", "--format", "json"], cwd, checkSignal, true);
  signal.throwIfAborted();
  let loggedIn = false;
  try {
    loggedIn = result.code === 0 && !checkSignal.aborted && hasSubscriptionLogin(result.stdout);
  } catch {
    // Metadata may be incomplete after a failed startup; do not expose it.
  }
  if (!loggedIn) {
    throw new Error(afterLogin
      ? "Choose a ChatGPT subscription method with `diffloupe auth login`; an API key cannot be used as a subscription."
      : "The ChatGPT subscription login is unavailable or has changed. Run `diffloupe auth login` before reviewing.");
  }
}

async function main(): Promise<void> {
  const [home, mode, ...args] = process.argv.slice(2);
  if (!home || (mode !== "manage" && mode !== "login" && mode !== "review" && mode !== "probe") || !args.length) {
    console.error("Invalid subscription worker invocation.");
    process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT");
  const terminate = () => controller.abort("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const cwd = mode === "review" ? process.cwd() : home;
  const reportProfile = mode === "review" && args[0] === "serve" && args.includes("--stdio");
  try {
    if (reportProfile) console.log(JSON.stringify({ diffloupe: "waiting-for-profile" }));
    const code = await withSubscriptionProfile(home, async () => {
      if (reportProfile) console.log(JSON.stringify({ diffloupe: "profile-acquired" }));
      if (mode === "review") await requireSubscription(cwd, controller.signal);
      // A queued probe may wait behind a whole review call. Its timeout starts
      // only after acquiring the lock, so a busy profile is not a failed login.
      const commandSignal = mode === "probe"
        ? AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
        : controller.signal;
      const result = await openCode(args, cwd, commandSignal);
      if (result.code === 0 && mode === "login") await requireSubscription(cwd, controller.signal, true);
      return result.code;
    }, controller.signal);
    process.exitCode = code;
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(error instanceof Error ? error.message : "Could not use the subscription profile.");
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    if (controller.signal.aborted) process.exitCode = controller.signal.reason === "SIGINT" ? 130 : 143;
  }
}

await main();
