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
  apiKeys?: {
    anthropic?: string;
  };
}

/**
 * Default config file location following XDG convention
 */
export function getConfigPath(): string {
  return join(homedir(), ".config", "diffloupe", "config.json");
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
 * Get the Anthropic API key from available sources.
 *
 * Priority:
 * 1. Explicit key passed as argument (e.g., from CLI --api-key)
 * 2. Config file (~/.config/diffloupe/config.json)
 * 3. ANTHROPIC_API_KEY environment variable
 *
 * @param explicitKey - Key passed explicitly (e.g., via CLI flag)
 * @returns The API key or undefined if not found
 */
export async function getAnthropicApiKey(
  explicitKey?: string
): Promise<string | undefined> {
  // Priority 1: Explicit key
  if (explicitKey) {
    return explicitKey;
  }

  // Priority 2: Config file
  const config = await loadConfig();
  if (config.apiKeys?.anthropic) {
    return config.apiKeys.anthropic;
  }

  // Priority 3: Environment variable
  return process.env["ANTHROPIC_API_KEY"];
}

/**
 * Clear the config cache (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
