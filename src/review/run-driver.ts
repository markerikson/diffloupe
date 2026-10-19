/**
 * The two halves of one review run, shared by the server and `--headless`:
 * `prepareRun` resolves the target and writes the run directory with a
 * pending `run.json`; `executeRun` runs the core and replaces it with the
 * finished (or failed, or cancelled) run.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { loadConfig } from "../services/config.ts";
import type { RunEvent, StartRunRequest } from "../server/types.ts";
import type { ReviewRun, ReviewTarget, RunKind } from "../types/review-run.ts";
import type { ReviewConfig } from "./core/config.ts";
import { text } from "./core/lib/proc.ts";
import type { Target } from "./core/lib/target.ts";
import { runReview, type ReviewEvent } from "./core/pipeline.ts";
import { runDiff, type RunDiffResult } from "./diff-run.ts";
import { describeAnchors } from "./anchors.ts";
import type { ReviewCommandOptions, ReviewModelStage } from "./options.ts";
import type { BuildPendingRunInput } from "./build-run.ts";
import { parseZeroContextDiff, priorComments, type LineHunk } from "./prior-run.ts";
import { groupsEvent } from "./run-groups.ts";
import {
  artifactsDir,
  createRunDir,
  dataDir,
  findPriorRunId,
  loadRun,
  loadState,
  remoteCopyDir,
  runDir,
  writeRun,
} from "./run-store.ts";
import { describeSource, MODEL_STAGES } from "./models.ts";
import { loadReviewSettings, settingsInstructions, settingsToConfig, type ReviewSettings } from "./settings.ts";
import { resolveRunSetup, runModels, setupConfig } from "./setup.ts";
import {
  needsRemoteCopy,
  openRemoteCopy,
  parseTargetSpec,
  pinnedTarget,
  resolveRemotePullRequest,
  resolveTarget,
  TargetError,
  type ResolvedTarget,
  type TargetSpec,
} from "./targets.ts";

export const INSTALL_HINTS: Record<string, string> = {
  git: "https://git-scm.com/downloads",
  opencode: "https://opencode.ai/docs/ (npm i -g opencode-ai)",
  tilth: "https://github.com/jahala/tilth (cargo install tilth)",
  gh: "https://cli.github.com/ (then `gh auth login`)",
};

type ModelKey = "model" | "modelMerge" | "modelWalk" | "modelIntent";

const STAGES: Record<ReviewModelStage, ModelKey> = {
  review: "model",
  coordinator: "modelMerge",
  walkthrough: "modelWalk",
  intent: "modelIntent",
};

/** `--model stage=id` pairs as a stage → model map. */
export function parseModelPairs(pairs: string[]): Partial<Record<ReviewModelStage, string>> {
  const out: Partial<Record<ReviewModelStage, string>> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const stage = pair.slice(0, eq);
    const id = pair.slice(eq + 1);
    if (eq <= 0 || !id || !(stage in STAGES)) {
      throw new TargetError(
        `--model expects stage=model-id with stage one of ${Object.keys(STAGES).join(", ")}; got "${pair}"`,
      );
    }
    out[stage as ReviewModelStage] = id;
  }
  return out;
}

/**
 * The run request for CLI options. Paths are made absolute so a server
 * started elsewhere reads the same files.
 */
export async function requestFromOptions(opts: ReviewCommandOptions): Promise<StartRunRequest> {
  let intent = opts.intent?.trim();
  if (!intent && opts.intentFile) intent = (await readFile(opts.intentFile, "utf8")).trim();
  const models = parseModelPairs(opts.model ?? []);
  return {
    ...(opts.kind === "diff" ? { kind: "diff" as const } : {}),
    ...(opts.kind === "diff" && opts.walkthrough ? { walkthrough: true } : {}),
    repo: path.resolve(opts.repo ?? process.cwd()),
    ...(opts.target ? { target: opts.target } : {}),
    ...(opts.base ? { base: opts.base } : {}),
    ...(intent ? { intent } : {}),
    ...(Object.keys(models).length ? { models } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.maxCost !== undefined ? { maxCostUsd: opts.maxCost } : {}),
    ...(opts.config ? { settingsFile: path.resolve(opts.config) } : {}),
    ...(opts.full ? { full: true } : {}),
  };
}

export function parseModelOverrides(pairs: string[]): Partial<Pick<ReviewConfig, ModelKey>> {
  return modelConfig(parseModelPairs(pairs));
}

function modelConfig(models: Partial<Record<ReviewModelStage, string>>): Partial<Pick<ReviewConfig, ModelKey>> {
  const out: Partial<Pick<ReviewConfig, ModelKey>> = {};
  for (const [stage, id] of Object.entries(models)) {
    const key = STAGES[stage as ReviewModelStage];
    if (key && id) out[key] = id;
  }
  return out;
}

/**
 * Throws a TargetError naming every required tool missing from PATH. A diff
 * run needs only git (and gh for a pull request), plus OpenCode for its
 * walkthrough.
 */
export function checkTools(
  targetSpec: string | undefined,
  run: { kind?: RunKind; walkthrough?: boolean } = {},
): void {
  const spec = parseTargetSpec(targetSpec);
  const agents = run.kind === "diff" ? (run.walkthrough ? ["opencode"] : []) : ["opencode", "tilth"];
  const needed = ["git", ...agents, ...(spec.kind === "pr" ? ["gh"] : [])];
  const missing = needed.filter((t) => !Bun.which(t, { PATH: process.env.PATH ?? "" }));
  if (missing.length) {
    throw new TargetError(
      ["Missing required tools on PATH:", ...missing.map((t) => `  ${t}: ${INSTALL_HINTS[t] ?? ""}`)].join("\n"),
    );
  }
}

export interface PreparedRun {
  id: string;
  kind: RunKind;
  /** Diff runs only: run the walkthrough. */
  walkthrough: boolean;
  dir: string;
  createdAt: string;
  repo: string;
  target: Target;
  reviewTarget: ReviewTarget;
  config: Partial<ReviewConfig>;
  maxCostUsd?: number;
  intent?: string;
  instructions?: string;
  patch: string;
  priorRunId?: string;
  previous?: { run: ReviewRun; dismissed: string[]; lineMap: Map<string, LineHunk[]> };
  /** Review runs only: 1 for a first review, one more than the prior run's otherwise. */
  round?: number;
  /** Review everything even when there is a prior run. */
  full: boolean;
  untrackedSkipped: string[];
  coreSource: string;
  models?: NonNullable<ReviewRun["meta"]["models"]>;
  /** The `run.json` written at start; the base of a failed or cancelled run. */
  pending: ReviewRun;
}

/**
 * Resolves the target, creates the run directory, writes the patch and a
 * pending `run.json`. A bad target throws TargetError before anything is
 * written. `log` receives the lines describing what is about to be reviewed.
 */
export async function prepareRun(
  req: StartRunRequest,
  defaultRepo: string,
  log: (message: string) => void,
  deps: { resolveSetup?: typeof resolveRunSetup } = {},
): Promise<PreparedRun> {
  const kind: RunKind = req.kind ?? "review";
  const isDiff = kind === "diff";
  const walkthrough = isDiff && req.walkthrough === true;
  const fromRun = req.fromRun;
  const from = fromRun
    ? await loadRun(fromRun).catch((err: unknown) => {
        throw new TargetError(`cannot start from run ${fromRun}: ${err instanceof Error ? err.message : String(err)}`);
      })
    : undefined;
  const fromSpec = from ? specOf(from.target) : undefined;
  if (from?.repo.remote && !isDiff) {
    throw new TargetError(
      `reviewing ${from.repo.slug ?? "this repository"} needs a local clone; ` +
        `run diffloupe review from a clone of it`,
    );
  }
  checkTools(fromSpec ? (fromSpec.kind === "pr" ? `#${fromSpec.pr}` : "") : req.target, { kind, walkthrough });
  const localRepo = path.resolve(req.repo ?? defaultRepo);
  const spec = from ? undefined : parseTargetSpec(req.target);
  // A pull request in a repository with no clone here is diffed from a remote copy.
  const remotePr =
    isDiff && spec?.kind === "pr" && spec.repo && (await needsRemoteCopy(localRepo, spec))
      ? { ...spec, repo: spec.repo }
      : undefined;
  if (remotePr) await openRemoteCopy(remoteCopyDir(remotePr.repo), remotePr.repo);
  const repo = from ? from.repo.root : remotePr ? remoteCopyDir(remotePr.repo) : localRepo;
  const remote = remotePr !== undefined || from?.repo.remote === true;
  const intent = req.intent?.trim() || from?.intent.stated || undefined;

  const userConfig = await loadConfig();
  const settings: ReviewSettings = req.settingsFile ? await loadReviewSettings(path.resolve(req.settingsFile)) : {};
  // A diff run resolves models and credentials only for its walkthrough, and
  // without one needs neither.
  const stages: readonly ReviewModelStage[] = isDiff ? (walkthrough ? ["walkthrough"] : []) : MODEL_STAGES;
  const setup = stages.length
    ? await (deps.resolveSetup ?? resolveRunSetup)({
        cli: { ...(req.models ? { models: req.models } : {}), ...(req.effort ? { effort: req.effort } : {}) },
        settings,
        userConfig,
        stages,
      })
    : undefined;
  const problems = setup ? [...setup.credentials.errors, ...(setup.catalog?.errors ?? [])] : [];
  if (problems.length) throw new TargetError(problems.join("\n"));
  const config: Partial<ReviewConfig> = {
    artifacts: artifactsDir(),
    out: path.join(dataDir(), "scratch"),
    ...settingsToConfig(settings),
    ...(setup ? setupConfig(setup) : {}),
  };
  const maxCostUsd = isDiff ? undefined : (req.maxCostUsd ?? userConfig.maxCostUsd);
  const instructions = isDiff ? undefined : settingsInstructions(settings);

  const resolved =
    from && fromSpec
      ? await pinnedTarget(repo, fromSpec, from.base, from.head, { isTaken })
      : remotePr
        ? await resolveRemotePullRequest(repo, remotePr, { isTaken })
        : await resolveTarget(repo, req.target, { ...(req.base ? { base: req.base } : {}), isTaken });
  const { target, changes, tag } = resolved;
  const pr = resolved.pullRequest;
  const verb = isDiff ? "Diff of" : "Reviewing";
  log(pr ? `${verb} ${target.slug}#${pr.number}: ${pr.title}` : `${verb} ${target.slug} (${describeSpec(resolved.spec)})`);
  const commits = resolved.commits === undefined ? "" : ` (${resolved.commits} commit${resolved.commits === 1 ? "" : "s"})`;
  log(`  ${target.base.slice(0, 12)}..${target.head.slice(0, 12)}${commits}`);
  log(`  ${changes.files} file(s) changed, +${changes.insertions} -${changes.deletions}`);
  log(`  run ${tag}`);
  if (setup) {
    for (const stage of stages) {
      const m = setup.models[stage];
      log(`  ${stage}: ${m.model} (${describeSource(m.source)})`);
    }
    for (const warning of setup.credentials.warnings) log(`  warning: ${warning}`);
  }
  if (maxCostUsd !== undefined) {
    log(
      setup?.catalog?.zeroCost.includes("review")
        ? "  cost limit not enforced: models report no cost"
        : `  cost limit $${maxCostUsd.toFixed(2)}`,
    );
  }
  if (resolved.skippedUntracked.length) {
    log(`  skipped ${resolved.skippedUntracked.length} untracked file(s) over 1 MB:`);
    for (const f of resolved.skippedUntracked) log(`    ${f}`);
  }

  const createdAt = new Date().toISOString();
  const runRepo = { root: repo, ...(target.slug ? { slug: target.slug } : {}), ...(remote ? { remote } : {}) };
  const reviewTarget = from ? from.target : await toReviewTarget(repo, resolved);
  const untrackedSkipped = from ? from.untrackedSkipped : resolved.skippedUntracked;
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
  const priorRunId = isDiff ? undefined : await findPriorRunId(runRepo, reviewTarget, createdAt);
  const previous = priorRunId ? await loadPrevious(repo, priorRunId, target.head) : undefined;
  if (previous?.run.findings.length) {
    log(`  ${previous.run.findings.length} finding(s) from prior run ${previous.run.id}`);
  }
  const full = req.full === true;
  const round = isDiff ? undefined : previous ? (await roundOf(previous.run)) + 1 : 1;
  if (round !== undefined && round > 1) {
    log(
      full
        ? `  round ${round}, full review (--full)`
        : `  round ${round}: reviewing what changed since ${previous?.run.head.slice(0, 12) ?? "the last review"} (--full to review everything)`,
    );
    if (round > ROUND_WARNING) {
      log(`  warning: this change has been reviewed ${round - 1} times; later rounds mostly find smaller problems`);
    }
  }
  const source = await coreSource();
  const models = setup ? runModels(setup, stages) : undefined;

  const { buildPendingRun } = await import("./build-run.ts");
  const pending = buildPendingRun({
    id: tag,
    createdAt,
    repo: runRepo,
    target: reviewTarget,
    base: target.base,
    head: target.head,
    ...(intent ? { statedIntent: intent } : {}),
    patch,
    untrackedSkipped,
    coreSource: source,
    ...(priorRunId ? { priorRunId } : {}),
    ...(round !== undefined ? { round } : {}),
    ...(models ? { models } : {}),
    ...(isDiff ? { kind } : {}),
  });
  await writeRun(pending);

  return {
    id: tag,
    kind,
    walkthrough,
    dir,
    createdAt,
    repo,
    target,
    reviewTarget,
    config,
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(intent ? { intent } : {}),
    ...(instructions ? { instructions } : {}),
    patch,
    ...(priorRunId ? { priorRunId } : {}),
    ...(previous ? { previous } : {}),
    ...(round !== undefined ? { round } : {}),
    full,
    untrackedSkipped,
    coreSource: source,
    ...(models ? { models } : {}),
    pending,
  };
}

export interface ExecuteRunOptions {
  signal: AbortSignal;
  /** Receives the core's events, with its `units` event turned into a `groups` event. */
  onProgress: (event: RunEvent) => void;
  log: (message: string) => void;
}

export interface ExecutedRun {
  run: ReviewRun;
  /** False when the target held no reviewable code and no model was called. Always true for diff runs. */
  reviewed: boolean;
}

/**
 * Runs the review core and writes the final `run.json`. On failure or
 * cancellation writes the pending run with that status and rethrows.
 */
export async function executeRun(prep: PreparedRun, opts: ExecuteRunOptions): Promise<ExecutedRun> {
  const { id, dir } = prep;
  const { buildReviewRun, buildGroupedPendingRun } = await import("./build-run.ts");
  // Replaced once the review units are known, so a reload mid-run and a failed
  // or cancelled run keep the groups instead of one "All changes" group.
  let pending = prep.pending;
  let pendingWrite: Promise<void> = Promise.resolve();
  const onProgress = (e: ReviewEvent) => {
    if (e.type !== "units") {
      opts.onProgress(e);
      return;
    }
    pending = buildGroupedPendingRun(pendingInput(prep), e.units, e.byClass);
    opts.onProgress(groupsEvent(pending));
    const written = pending;
    pendingWrite = pendingWrite.then(() =>
      writeRun(written).catch((err: unknown) => {
        opts.log(`  could not save the grouped run: ${err instanceof Error ? err.message : String(err)}`);
      }),
    );
  };
  let result: RunDiffResult & { markdownPath?: string };
  try {
    result =
      prep.kind === "diff"
        ? await runDiff({
            repo: prep.repo,
            target: prep.target,
            tag: id,
            config: prep.config,
            walkthrough: prep.walkthrough,
            signal: opts.signal,
            ...(prep.intent ? { intent: prep.intent } : {}),
            onProgress,
          })
        : await runReview({
            repo: prep.repo,
            target: prep.target,
            tag: id,
            config: prep.config,
            local: true,
            signal: opts.signal,
            ...(prep.maxCostUsd !== undefined ? { maxCostUsd: prep.maxCostUsd } : {}),
            ...(prep.intent ? { intent: prep.intent } : {}),
            ...(prep.instructions ? { instructions: prep.instructions } : {}),
            ...(prep.previous ? { prior: priorComments(prep.previous.run) } : {}),
            ...(prep.previous && !prep.full ? { priorHead: prep.previous.run.head } : {}),
            onProgress,
          });
  } catch (err) {
    const cancelled = opts.signal.aborted;
    await pendingWrite;
    await writeRun({
      ...pending,
      status: cancelled ? "cancelled" : "failed",
      ...(cancelled ? {} : { error: err instanceof Error ? err.message : String(err) }),
    });
    throw err;
  }

  if (result.markdownPath) {
    const artifacts = prep.config.artifacts ?? artifactsDir();
    await copyIfPresent(path.join(artifacts, "runs", `${id}.json`), path.join(dir, "raw", "record.json"));
    await copyIfPresent(result.markdownPath, path.join(dir, "raw", "review.md"));
    await copyIfPresent(path.join(artifacts, "reviews", `${id}.payloads.json`), path.join(dir, "raw", "payloads.json"));
  } else if (result.record) {
    await writeFile(path.join(dir, "raw", "record.json"), `${JSON.stringify(result.record, null, 2)}\n`);
  }
  await writeFile(path.join(dir, "raw", "units.json"), `${JSON.stringify(result.units, null, 2)}\n`);
  await writeFile(path.join(dir, "raw", "byClass.json"), `${JSON.stringify(result.byClass, null, 2)}\n`);

  let run: ReviewRun;
  await pendingWrite;
  try {
    run = buildReviewRun({
      ...pendingInput(prep),
      result,
      ...(prep.previous ? { previous: prep.previous } : {}),
      log: opts.log,
    });
  } catch (err) {
    const message = `building run.json: ${err instanceof Error ? err.message : String(err)}`;
    await writeRun({ ...pending, status: "failed", error: message });
    throw new Error(message, { cause: err });
  }
  await writeRun(run);
  if (prep.kind === "review") opts.log(`  anchors: ${describeAnchors(run)}`);
  return { run, reviewed: prep.kind === "diff" || result.record !== null };
}

function pendingInput(prep: PreparedRun): BuildPendingRunInput {
  return {
    id: prep.id,
    createdAt: prep.createdAt,
    repo: prep.pending.repo,
    target: prep.reviewTarget,
    base: prep.target.base,
    head: prep.target.head,
    ...(prep.intent ? { statedIntent: prep.intent } : {}),
    patch: prep.patch,
    untrackedSkipped: prep.untrackedSkipped,
    coreSource: prep.coreSource,
    ...(prep.priorRunId ? { priorRunId: prep.priorRunId } : {}),
    ...(prep.round !== undefined ? { round: prep.round } : {}),
    ...(prep.models ? { models: prep.models } : {}),
    ...(prep.kind === "diff" ? { kind: prep.kind } : {}),
  };
}

/** Reviews past this many rounds get a warning; the extra rounds rarely pay. */
const ROUND_WARNING = 3;

/**
 * A run's round. Runs saved before rounds were recorded count the prior runs
 * they link back to.
 */
export async function roundOf(run: Pick<ReviewRun, "round" | "priorRunId">, load = loadRun): Promise<number> {
  if (run.round !== undefined) return run.round;
  const walk = async (next: string | undefined, seen: Set<string>): Promise<number> => {
    if (!next || seen.has(next)) return 1;
    seen.add(next);
    const prior = await load(next).catch(() => undefined);
    if (!prior) return 1;
    return 1 + (prior.round ?? (await walk(prior.priorRunId, seen)));
  };
  return walk(run.priorRunId, new Set());
}

/**
 * The prior run of this target, the findings its reader dismissed, and the
 * line moves between its head and this one. Any failure here means reviewing
 * without the prior run rather than not reviewing.
 */
async function loadPrevious(
  repo: string,
  id: string,
  head: string,
): Promise<{ run: ReviewRun; dismissed: string[]; lineMap: Map<string, LineHunk[]> } | undefined> {
  try {
    const run = await loadRun(id);
    const state = await loadState(id);
    const dismissed = Object.entries(state.findingStatus)
      .filter(([, status]) => status === "dismissed")
      .map(([fid]) => fid);
    let lineMap = new Map<string, LineHunk[]>();
    const files = [...new Set(run.findings.map((f) => f.file))];
    if (run.head !== head && files.length) {
      try {
        const diff = await text("git", ["-C", repo, "diff", "-U0", "--no-color", "--no-ext-diff", run.head, head, "--", ...files]);
        lineMap = parseZeroContextDiff(diff);
      } catch {
        // The prior head is gone (an unpinned snapshot, a gc): lines stay where they were.
      }
    }
    return { run, dismissed, lineMap };
  } catch {
    return undefined;
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
    const sha = (await text("git", ["-C", import.meta.dir, "rev-parse", "--short=12", "HEAD"])).trim();
    cachedCoreSource = `diffloupe@${sha}`;
  } catch {
    cachedCoreSource = "diffloupe";
  }
  return cachedCoreSource;
}

const isTaken = (tag: string) => existsSync(runDir(tag));

/** The target spec an earlier run was started with. */
function specOf(t: ReviewTarget): TargetSpec {
  switch (t.kind) {
    case "pr":
      return { kind: "pr", pr: t.number };
    case "branch":
      return { kind: "branch", branch: t.spec };
    case "commit":
      return { kind: "commit", rev: t.spec };
    case "range":
      return parseTargetSpec(`range:${t.spec}`);
    default:
      return { kind: t.kind };
  }
}

function describeSpec(spec: TargetSpec): string {
  switch (spec.kind) {
    case "branch":
      return `branch ${spec.branch}`;
    case "commit":
      return `commit ${spec.rev}`;
    case "range":
      return `range ${spec.from}${spec.mergeBase ? "..." : ".."}${spec.to}`;
    default:
      return spec.kind;
  }
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

/** The review markdown saved in the run directory, if the run wrote one. */
export async function readRunMarkdown(dir: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(dir, "raw", "review.md"), "utf8");
  } catch {
    return undefined;
  }
}
