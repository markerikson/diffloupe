/**
 * Per-repo review settings, loaded from the file passed to `--config`.
 *
 * {
 *   "provider": "anthropic",
 *   "models": { "review": "...", "coordinator": "...", "walkthrough": "..." },
 *   "effort": "medium",
 *   "surfaces": { "deploy": ["^infra/"], "tooling": ["^docs/"] },
 *   "extraExcludes": ["vendor/openssl/"]
 * }
 *
 * surfaces are regex sources matched against repo-relative paths. They replace
 * the defaults for whichever list is given. extraExcludes are path substrings
 * left out of the code map and the registry check.
 */
import { readFile } from "node:fs/promises";
import { type } from "arktype";
import { SURFACES, type ReviewConfig } from "./core/config.ts";
import { TargetError } from "./targets.ts";

const ReviewSettings = type({
  "+": "reject",
  "$schema?": "string",
  "provider?": "string",
  "models?": {
    "+": "reject",
    "review?": "string",
    "coordinator?": "string",
    "walkthrough?": "string",
  },
  "effort?": "string",
  "surfaces?": {
    "+": "reject",
    "deploy?": "string[]",
    "tooling?": "string[]",
  },
  "extraExcludes?": "string[]",
});

export type ReviewSettings = typeof ReviewSettings.infer;

export function parseReviewSettings(json: unknown, source: string): ReviewSettings {
  const settings = ReviewSettings(json);
  if (settings instanceof type.errors) {
    throw new TargetError(`invalid settings in ${source}: ${settings.summary}`);
  }
  for (const pattern of [...(settings.surfaces?.deploy ?? []), ...(settings.surfaces?.tooling ?? [])]) {
    try {
      new RegExp(pattern);
    } catch (err) {
      throw new TargetError(
        `invalid surface pattern in ${source}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return settings;
}

export async function loadReviewSettings(file: string): Promise<ReviewSettings> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    throw new TargetError(`cannot read settings file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new TargetError(`settings file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseReviewSettings(json, file);
}

/** Converts settings to review-core config. Model and effort keys are left to the caller's precedence rules. */
export function settingsToConfig(settings: ReviewSettings): Partial<ReviewConfig> {
  const config: Partial<ReviewConfig> = {};
  if (settings.surfaces) {
    config.surfaces = {
      deploy: settings.surfaces.deploy ?? SURFACES.deploy,
      tooling: settings.surfaces.tooling ?? SURFACES.tooling,
    };
  }
  if (settings.extraExcludes) config.extraExcludes = settings.extraExcludes;
  return config;
}
