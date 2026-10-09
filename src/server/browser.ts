/**
 * Opens a URL in the user's browser. Trimmed from Plannotator
 * (https://github.com/backnotprop/plannotator, packages/server/browser.ts @
 * 5d39c981, MIT OR Apache-2.0): `BROWSER`, WSL through cmd.exe, else xdg-open.
 */
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";

const NOOP_BROWSER_VALUES = new Set(["true", "false", "none", ":", "0", "1"]);

export function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  if (os.release().toLowerCase().includes("microsoft")) return true;
  try {
    const version = readFileSync("/proc/version", "utf8").toLowerCase();
    return version.includes("microsoft") || version.includes("wsl");
  } catch {
    return false;
  }
}

/** A value that must go through cmd.exe under WSL: a Windows path, a /mnt/<drive> path, or a .exe. */
function isWindowsBrowserTarget(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/mnt/") || value.toLowerCase().endsWith(".exe");
}

export function browserCommand(
  url: string,
  env: { browser?: string | undefined; wsl: boolean; platform: NodeJS.Platform },
): string[] {
  const browser = env.browser?.trim() && !NOOP_BROWSER_VALUES.has(env.browser.trim().toLowerCase())
    ? env.browser.trim()
    : undefined;
  // `start` takes its first quoted argument as a window title. An empty
  // argument is quoted to `""` on the Windows command line; a literal '""'
  // argument would be escaped to `"\"\""` instead.
  if (env.wsl) {
    if (!browser) return ["cmd.exe", "/c", "start", "", url];
    if (isWindowsBrowserTarget(browser)) return ["cmd.exe", "/c", "start", "", browser, url];
    return [browser, url];
  }
  if (browser) return [browser, url];
  if (env.platform === "darwin") return ["open", url];
  if (env.platform === "win32") return ["cmd.exe", "/c", "start", "", url];
  return ["xdg-open", url];
}

/** Opens `url`; returns false when the launcher could not be run. */
export async function openBrowser(url: string): Promise<boolean> {
  const wsl = isWSL();
  const cmd = browserCommand(url, { browser: process.env.BROWSER, wsl, platform: process.platform });
  try {
    const proc = Bun.spawn(cmd, {
      stdio: ["ignore", "ignore", "ignore"],
      // cmd.exe warns about and falls back from a UNC (\\wsl$) working directory.
      ...(wsl && cmd[0] === "cmd.exe" && existsSync("/mnt/c") ? { cwd: "/mnt/c" } : {}),
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
