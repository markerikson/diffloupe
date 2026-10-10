/**
 * The parts of the user's global OpenCode config that a review borrows: the
 * default `model`, and the `providers` block that defines custom providers and
 * their credentials. Reviews otherwise run with a config DiffLoupe writes, so
 * nothing else from the user's setup reaches them.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonc } from "./core/lib/module-resolver.ts";

export interface OpenCodeUserConfig {
  /** The file the values came from. */
  path?: string;
  /** `provider/model`, as OpenCode stores it. */
  model?: string;
  /** The `providers` block, copied unchanged. */
  providers?: Record<string, unknown>;
}

/** Candidate global config files, in OpenCode's lookup order. */
export function openCodeConfigPaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  const base = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  const dir = path.join(base, "opencode");
  return ["opencode.jsonc", "opencode.json"].map((f) => path.join(dir, f));
}

/** JSON with comments and trailing commas. Undefined when it does not parse. */
export function parseOpenCodeConfig(text: string): unknown {
  const jsonc = (Bun as { JSONC?: { parse(text: string): unknown } }).JSONC;
  if (jsonc) {
    try {
      return jsonc.parse(text);
    } catch {
      return undefined;
    }
  }
  return parseJsonc(text);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Picks `model` and `providers` out of a parsed config. */
export function userConfigFrom(json: unknown, file?: string): OpenCodeUserConfig {
  if (!isRecord(json)) return {};
  const out: OpenCodeUserConfig = file ? { path: file } : {};
  if (typeof json.model === "string" && json.model.trim()) out.model = json.model.trim();
  if (isRecord(json.providers)) out.providers = json.providers;
  return out;
}

/** The user's global OpenCode config. Missing or unreadable means none. */
export function readOpenCodeUserConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): OpenCodeUserConfig {
  for (const file of openCodeConfigPaths(env, home)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    return userConfigFrom(parseOpenCodeConfig(text), file);
  }
  return {};
}
