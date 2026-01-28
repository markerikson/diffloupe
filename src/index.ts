/**
 * Entry point for DiffLoupe CLI
 * 
 * We explicitly load .env from the script's directory (not cwd) so that
 * the tool works when run from any directory via `bun run /path/to/diffloupe/src/index.ts`
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env from the script's directory, not cwd
// This ensures ANTHROPIC_API_KEY is available when running from other directories
const scriptDir = dirname(fileURLToPath(import.meta.url));
const envPath = join(scriptDir, "..", ".env");

// Bun.file().text() would require async, so use sync approach
const envFile = Bun.file(envPath);
if (await envFile.exists()) {
  const envContent = await envFile.text();
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    // Only set if not already set (existing env vars take precedence)
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

import { run } from "./cli/index.js";

run();
