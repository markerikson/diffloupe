import { spawn } from "node:child_process";
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { checkOpenCodeVersion, INSTALL_HINTS } from "../review/run-driver.ts";
import { subscriptionCommand, subscriptionEnv, subscriptionHome } from "../review/subscription.ts";

type AuthAction = "login" | "status" | "logout";

function openaiOnly(provider: string): string {
  if (provider !== "openai") throw new InvalidArgumentError("subscription authentication supports openai only");
  return provider;
}

/** Keep terminal prompts in OpenCode while its worker owns the profile lock. */
function authProcess(action: AuthAction, home: string, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const args = action === "status" ? ["auth", "list"] : ["auth", action, "openai"];
  const spec = subscriptionCommand(home, [...args, "--standalone"], action === "login" ? "login" : "manage");
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      env: subscriptionEnv(home),
      stdio: "inherit",
      detached: true,
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (killSignal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, killSignal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const abort = () => {
      signalGroup(signal.reason === "SIGINT" ? "SIGINT" : "SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), 5_000);
      killTimer.unref();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      clearTimeout(killTimer);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, killedBy) => {
      cleanup();
      resolve(code ?? (killedBy === "SIGINT" ? 130 : killedBy === "SIGTERM" ? 143 : 1));
    });
  });
}

async function authenticate(action: AuthAction): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT");
  const terminate = () => controller.abort("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    if (!Bun.which("opencode")) throw new Error(`OpenCode is not on PATH. Install: ${INSTALL_HINTS.opencode}`);
    await checkOpenCodeVersion();
    const home = subscriptionHome();
    if (action === "login") {
      console.log("Choose a ChatGPT subscription method in OpenCode's login prompts.");
    }
    const code = await authProcess(action, home, controller.signal);
    if (code !== 0) process.exitCode = code;
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(pc.red(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    if (controller.signal.aborted) process.exitCode = controller.signal.reason === "SIGINT" ? 130 : 143;
  }
}

export function createAuthCommand(): Command {
  const auth = new Command("auth").description("Manage DiffLoupe's ChatGPT subscription login");
  auth.command("login")
    .description("Sign in to ChatGPT in DiffLoupe's dedicated OpenCode profile")
    .argument("[provider]", "Subscription provider (openai)", openaiOnly, "openai")
    .action(async () => authenticate("login"));
  auth.command("status")
    .description("List accounts in DiffLoupe's subscription profile")
    .action(async () => authenticate("status"));
  auth.command("logout")
    .description("Remove a ChatGPT login from DiffLoupe's subscription profile")
    .argument("[provider]", "Subscription provider (openai)", openaiOnly, "openai")
    .action(async () => authenticate("logout"));
  return auth;
}
