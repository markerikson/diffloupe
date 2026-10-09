/**
 * `diffloupe review --headless`: resolve a target, run the ported review core,
 * print the review markdown to stdout and progress to stderr.
 */
import path from "node:path";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { getAnthropicApiKey, loadConfig } from "../services/config.ts";
import type { ReviewRun, ReviewTarget } from "../types/review-run.ts";
import { describeAnchors } from "./anchors.ts";
import type { ReviewConfig } from "./core/config.ts";
import { text } from "./core/lib/proc.ts";
import { runReview, type ReviewEvent, type RunReviewResult } from "./core/pipeline.ts";
import type { ReviewCommandOptions, ReviewModelStage } from "./options.ts";
import { appendEvent, artifactsDir, createRunDir, dataDir, findPriorRunId, writeRun } from "./run-store.ts";
import { loadReviewSettings, settingsToConfig, type ReviewSettings } from "./settings.ts";
import { parseTargetSpec, resolveTarget, TargetError, type ResolvedTarget } from "./targets.ts";

export { dataDir };

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

    const createdAt = new Date().toISOString();
    const runRepo = {
      root: repo,
      ...(target.slug ? { slug: target.slug } : {}),
    };
    const reviewTarget = await toReviewTarget(repo, resolved);
    const dir = await createRunDir(tag);
    const patch = await text("git", [
      "-C",
      repo,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--full-index",
      "-M",
      target.base,
      target.head,
    ]);
    await writeFile(path.join(dir, "diff.patch"), patch);
    const priorRunId = await findPriorRunId(runRepo, reviewTarget, createdAt);
    const source = await coreSource();
    const failedRun = (message: string): ReviewRun => ({
      schemaVersion: 1,
      id: tag,
      status: "failed",
      createdAt,
      repo: runRepo,
      target: reviewTarget,
      base: target.base,
      head: target.head,
      intent: intent ? { stated: intent } : {},
      overview: { startHere: [] },
      files: [],
      groups: [],
      stops: [],
      findings: [],
      overCapFindings: [],
      resolved: [],
      unreviewed: { overCap: [], failed: [] },
      meta: {
        wallMs: 0,
        costUsd: 0,
        slices: [],
        rejectedCount: 0,
        coreSource: source,
      },
      untrackedSkipped: resolved.skippedUntracked,
      ...(priorRunId ? { priorRunId } : {}),
      error: message,
    });

    // Events are appended in order; the chain is awaited before run.json is written.
    let events = Promise.resolve();
    let result: RunReviewResult;
    try {
      result = await runReview({
        repo,
        target,
        tag,
        config,
        ...(intent ? { intent } : {}),
        onProgress: (e) => {
          events = events.then(() => appendEvent(tag, e)).catch(() => {});
          const line = formatEvent(e);
          if (line) log(line);
        },
      });
    } catch (err) {
      await events;
      await writeRun(failedRun(err instanceof Error ? err.message : String(err)));
      throw err;
    }
    await events;

    const artifacts = config.artifacts ?? artifactsDir();
    await copyIfPresent(path.join(artifacts, "runs", `${tag}.json`), path.join(dir, "raw", "record.json"));
    await copyIfPresent(result.markdownPath, path.join(dir, "raw", "review.md"));
    await copyIfPresent(
      path.join(artifacts, "reviews", `${tag}.payloads.json`),
      path.join(dir, "raw", "payloads.json"),
    );
    await writeFile(path.join(dir, "raw", "units.json"), `${JSON.stringify(result.units, null, 2)}\n`);
    await writeFile(path.join(dir, "raw", "byClass.json"), `${JSON.stringify(result.byClass, null, 2)}\n`);

    const { buildReviewRun } = await import("./build-run.ts");
    let run: ReviewRun;
    try {
      run = buildReviewRun({
        id: tag,
        createdAt,
        repo: runRepo,
        target: reviewTarget,
        base: target.base,
        head: target.head,
        ...(intent ? { statedIntent: intent } : {}),
        patch,
        result,
        untrackedSkipped: resolved.skippedUntracked,
        coreSource: source,
        ...(priorRunId ? { priorRunId } : {}),
        log,
      });
    } catch (err) {
      await writeRun(failedRun(`building run.json: ${err instanceof Error ? err.message : String(err)}`));
      throw err;
    }
    await writeRun(run);
    log(`  anchors: ${describeAnchors(run)}`);

    if (!result.record) {
      log("No code changes to review.");
      log(`Run saved: ${dir}`);
      return 0;
    }
    process.stdout.write(await readFile(result.markdownPath, "utf8"));
    log(
      `\n${result.findings.length} finding(s) · $${result.costUsd.toFixed(2)} · ` +
        `${Math.round(result.wallMs / 1000)}s · ${result.markdownPath}`,
    );
    log(`Run saved: ${dir} (diffloupe runs show ${tag})`);
    return 0;
  } catch (err) {
    log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function copyIfPresent(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to);
  } catch {
    // Not every run writes every artifact: payloads exist only for a pull request.
  }
}

let cachedCoreSource: string | undefined;

/** The DiffLoupe commit the review ran from, when running from a checkout. */
async function coreSource(): Promise<string> {
  if (cachedCoreSource) return cachedCoreSource;
  try {
    const sha = (await text("git", ["-C", import.meta.dir, "rev-parse", "--short", "HEAD"])).trim();
    cachedCoreSource = `diffloupe@${sha}`;
  } catch {
    cachedCoreSource = "diffloupe";
  }
  return cachedCoreSource;
}

export async function toReviewTarget(repo: string, resolved: ResolvedTarget): Promise<ReviewTarget> {
  const { spec, pullRequest: pr } = resolved;
  if (spec.kind === "pr") {
    return {
      kind: "pr",
      number: spec.pr,
      url: pr?.url ?? "",
      title: pr?.title ?? "",
      author: pr?.author.login ?? "",
      baseRef: pr?.baseRefName ?? "",
      headRef: pr?.headRefName ?? "",
      state: pr?.state ?? "",
      isDraft: pr?.isDraft ?? false,
    };
  }
  if (spec.kind === "branch") return { kind: "branch", spec: spec.branch };
  if (spec.kind === "commit") return { kind: "commit", spec: spec.rev };
  if (spec.kind === "range")
    return {
      kind: "range",
      spec: `${spec.from}${spec.mergeBase ? "..." : ".."}${spec.to}`,
    };
  let branch: string | undefined;
  try {
    branch = (await text("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])).trim() || undefined;
  } catch {
    // An empty repository has no HEAD to name.
  }
  return { kind: spec.kind, ...(branch ? { branch } : {}) };
}
