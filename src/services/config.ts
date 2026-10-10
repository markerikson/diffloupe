/**
 * Configuration service for DiffLoupe
 *
 * Handles loading configuration from multiple sources with priority:
 * 1. Explicit values (e.g., CLI flags)
 * 2. Config file (~/.config/diffloupe/config.json)
 * 3. Environment variables
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { fileExists, readTextFile } from "../runtime/index.js";

/**
 * Shape of the config file
 */
export interface DiffLoupeConfig {
  /**
   * API keys keyed by OpenCode provider id (`anthropic`, `openai`, ...). Given
   * to the OpenCode processes a review starts, never to DiffLoupe's own
   * environment.
   */
  apiKeys?: Record<string, string>;
  /** Provider prefix for a bare model name. Default `anthropic`. */
  provider?: string;
  opencode?: {
    /**
     * Use the `model` from the user's global OpenCode config for any stage
     * DiffLoupe has no model for. Default true.
     */
    useDefaultModel?: boolean;
  };
  /** Model IDs for `diffloupe review`, per stage. */
  models?: {
    /** Slice reviewers. */
    review?: string;
    /** Merges and verifies the slice findings. */
    coordinator?: string;
    /** Writes the walkthrough and names the review groups. */
    walkthrough?: string;
  };
  /** Reasoning effort for `diffloupe review` (low, medium, high, ...). */
  effort?: string;
  /** Port the local server listens on. Default 4517. */
  port?: number;
  /** Address the local server binds to. Default 127.0.0.1. */
  host?: string;
  /** Default `--max-cost` for a review, in US dollars. No limit when unset. */
  maxCostUsd?: number;
}

/**
 * Default config file location following XDG convention
 */
export function getConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "diffloupe", "config.json");
}

let cachedConfig: DiffLoupeConfig | null = null;

/**
 * Load config from file. Returns empty object if file doesn't exist.
 * Caches the result for subsequent calls.
 */
export async function loadConfig(): Promise<DiffLoupeConfig> {
  if (cachedConfig !== null) {
    return cachedConfig;
  }

  const configPath = getConfigPath();

  if (!(await fileExists(configPath))) {
    cachedConfig = {};
    return cachedConfig;
  }

  try {
    const content = await readTextFile(configPath);
    cachedConfig = JSON.parse(content) as DiffLoupeConfig;
    return cachedConfig;
  } catch {
    // If config file is malformed, treat as empty
    cachedConfig = {};
    return cachedConfig;
  }
}

/**
 * Clear the config cache (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
