/**
 * `diffloupe review --headless`: resolve a target, run the ported review core,
 * print the review markdown to stdout and progress to stderr.
 */
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { getAnthropicApiKey, loadConfig } from "../services/config.ts";
import type { ReviewConfig } from "./core/config.ts";
import { runReview, type ReviewEvent } from "./core/pipeline.ts";
import type { ReviewCommandOptions, ReviewModelStage } from "./options.ts";
import { loadReviewSettings, settingsToConfig, type ReviewSettings } from "./settings.ts";
import { parseTargetSpec, resolveTarget, TargetError } from "./targets.ts";

const INSTALL_HINTS: Record<string, string> = {
  git: "https://git-scm.com/downloads",
  opencode: "https://opencode.ai/docs/ (npm i -g opencode-ai)",
  tilth: "https://github.com/jahala/tilth (cargo install tilth)",
  gh: "https://cli.github.com/ (then `gh auth login`)",
};

type ModelKey = "model" | "modelMerge" | "modelWalk";

const STAGES: Record<ReviewModelStage, ModelKey> = {
  review: "model",
  coordinator: "modelMerge",
  walkthrough: "modelWalk",
};

export function dataDir(): string {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "diffloupe");
}

export function parseModelOverrides(pairs: string[]): Partial<Pick<ReviewConfig, ModelKey>> {
  const out: Partial<Pick<ReviewConfig, ModelKey>> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const stage = pair.slice(0, eq) as ReviewModelStage;
    const id = pair.slice(eq + 1);
    if (eq <= 0 || !id || !(stage in STAGES)) {
      throw new TargetError(
        `--model expects stage=model-id with stage one of ${Object.keys(STAGES).join(", ")}; got "${pair}"`,
      );
    }
    out[STAGES[stage]] = id;
  }
  return out;
}

function formatEvent(e: ReviewEvent): string | null {
  if (e.type === "stage") return `» ${e.stage.replaceAll("_", " ")}`;
  if (e.type === "log") return e.message;
  const n = `[${e.index + 1}/${e.total}]`;
  if (e.status === "started") return `  ${n} ${e.title}`;
  const cost = e.costUsd !== undefined ? ` $${e.costUsd.toFixed(2)}` : "";
  const wall = e.wallMs !== undefined ? ` ${Math.round(e.wallMs / 1000)}s` : "";
  const found = e.findings !== undefined ? ` ${e.findings} finding(s)` : "";
  return `  ${n} ${e.status === "ok" ? "done" : "FAILED"}${cost}${wall}${found} — ${e.title}`;
}

/** Runs one headless review. Returns the process exit code. */
export async function runHeadlessReview(opts: ReviewCommandOptions): Promise<number> {
  const log = (s: string) => console.error(s);
  try {
    const spec = parseTargetSpec(opts.target);
    const needed = ["git", "opencode", "tilth", ...(spec.kind === "pr" ? ["gh"] : [])];
    const missing = needed.filter((t) => !Bun.which(t));
    if (missing.length) {
      log(`Missing required tools on PATH:`);
      for (const t of missing) log(`  ${t}: ${INSTALL_HINTS[t] ?? ""}`);
      return 1;
    }

    const repo = path.resolve(opts.repo ?? process.cwd());
    let intent = opts.intent?.trim();
    if (!intent && opts.intentFile) intent = (await readFile(opts.intentFile, "utf8")).trim();

    // Precedence: CLI flags, then the --config settings file, then
    // ~/.config/diffloupe/config.json, then the core defaults.
    const userConfig = await loadConfig();
    const settings: ReviewSettings = opts.config ? await loadReviewSettings(path.resolve(opts.config)) : {};
    const models = { ...userConfig.models, ...settings.models };
    const config: Partial<ReviewConfig> = {
      artifacts: path.join(dataDir(), "artifacts"),
      out: path.join(dataDir(), "scratch"),
      ...settingsToConfig(settings),
    };
    if (models.review) config.model = models.review;
    if (models.coordinator) config.modelMerge = models.coordinator;
    if (models.walkthrough) config.modelWalk = models.walkthrough;
    const effort = opts.effort ?? settings.effort ?? userConfig.effort;
    if (effort) config.effort = effort;
    Object.assign(config, parseModelOverrides(opts.model ?? []));

    // OpenCode runs with relocated data directories, so it never sees the
    // user's stored login; the provider key has to come through the environment.
    if (!process.env.ANTHROPIC_API_KEY) {
      const key = await getAnthropicApiKey();
      if (key) process.env.ANTHROPIC_API_KEY = key;
    }

    const resolved = await resolveTarget(repo, opts.target, opts.base ? { base: opts.base } : {});
    const { target, changes, tag } = resolved;
    const pr = resolved.pullRequest;
    log(pr ? `Reviewing ${target.slug}#${pr.number}: ${pr.title}` : `Reviewing ${target.slug} (${resolved.spec.kind})`);
    log(`  ${target.base.slice(0, 10)}..${target.head.slice(0, 10)}`);
    log(`  ${changes.files} file(s) changed, +${changes.insertions} -${changes.deletions}`);
    log(`  tag ${tag}`);
    if (resolved.skippedUntracked.length) {
      log(`  skipped ${resolved.skippedUntracked.length} untracked file(s) over 1 MB:`);
      for (const f of resolved.skippedUntracked) log(`    ${f}`);
    }

    const result = await runReview({
      repo,
      target,
      tag,
      config,
      ...(intent ? { intent } : {}),
      onProgress: (e) => {
        const line = formatEvent(e);
        if (line) log(line);
      },
    });

    if (!result.record) {
      log("No code changes to review.");
      return 0;
    }
    process.stdout.write(await readFile(result.markdownPath, "utf8"));
    log(
      `\n${result.findings.length} finding(s) · $${result.costUsd.toFixed(2)} · ` +
        `${Math.round(result.wallMs / 1000)}s · ${result.markdownPath}`,
    );
    return 0;
  } catch (err) {
    log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
