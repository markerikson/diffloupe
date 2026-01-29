import { x } from "tinyexec";
import { readFile, access } from "node:fs/promises";

export const isBun = typeof Bun !== "undefined";

/**
 * Read file contents as text
 */
export async function readTextFile(path: string): Promise<string> {
  if (isBun) {
    return Bun.file(path).text();
  }
  return readFile(path, "utf-8");
}

/**
 * Check if file exists
 */
export async function fileExists(path: string): Promise<boolean> {
  if (isBun) {
    return Bun.file(path).exists();
  }
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read all of stdin as text
 */
export async function readStdin(): Promise<string> {
  if (isBun) {
    return Bun.stdin.text();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Spawn a subprocess and capture output
 */
export async function spawn(
  cmd: string,
  args: string[],
  options?: { cwd?: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (isBun) {
    const spawnOptions: { stdout: "pipe"; stderr: "pipe"; cwd?: string } = {
      stdout: "pipe",
      stderr: "pipe",
    };
    if (options?.cwd) {
      spawnOptions.cwd = options.cwd;
    }
    const proc = Bun.spawn([cmd, ...args], spawnOptions);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  // Use tinyexec for Node.js
  const result = await x(cmd, args, {
    nodeOptions: { cwd: options?.cwd },
    throwOnError: false,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 0,
  };
}
