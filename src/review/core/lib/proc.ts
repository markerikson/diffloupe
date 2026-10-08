/**
 * Child-process helpers.
 *
 * Output is collected without a buffer ceiling: a whole-PR `git diff` and a
 * paginated `gh api` both routinely exceed the 1 MB default that execFile
 * imposes, and truncation there is silent.
 */
import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  /** Set when the child was killed rather than exiting on its own. */
  signal?: NodeJS.Signals;
}

export interface RunOptions {
  cwd?: string;
  /** Return a non-zero result instead of throwing. */
  allowFail?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      // A child killed by a signal reports a null exit code. Defaulting that to
      // 0 turns an OOM kill, a timeout or a SIGPIPE into an apparent success
      // carrying whatever partial output was collected — which for a `git diff`
      // or a paginated `gh api` is a truncated result the caller then trusts.
      const result: RunResult = {
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? (signal ? 128 : 0),
        ...(signal ? { signal } : {}),
      };
      if (result.code !== 0 && !opts.allowFail) {
        reject(
          new Error(
            `${cmd} ${args.join(" ")} ${signal ? `killed by ${signal}` : `exited ${result.code}`}\n` +
              result.stderr.slice(0, 2000),
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

/** stdout of a command that must succeed. */
export async function text(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return (await run(cmd, args, opts)).stdout;
}

/** stdout of a command that must succeed, parsed as JSON. */
export async function json<T = unknown>(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<T> {
  return JSON.parse(await text(cmd, args, opts)) as T;
}
