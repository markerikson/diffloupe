/**
 * Slice -> merge -> verify -> render review pipeline.
 *
 * Shape comes from the harness results: whole-diff review cannot attend to a
 * small hunk inside a large diff, so the unit of review is one changed file.
 * A coordinator pass then dedups across slices, drops unsupported claims, and
 * reconciles against comments already posted on the PR.
 */
import path from "node:path";
import { registryCheck, renderRegistryReport } from "./registry-check.ts";
import { buildDiffSeededMap } from "./build-map.ts";
import { groupChanges } from "./change-groups.ts";
import { projectFilesFromGit } from "./lib/module-resolver.ts";
import { crossGroupLinkLines, groupLinkLines, selectWalkFiles, sketchFiles, sketchLine } from "./lib/walk-input.ts";
import { applyGroupNaming, crossLinksFor, type GroupNaming } from "./lib/grouping.ts";
import { countLines, ensureDir, exists, removeIfPresent, writeJson, writeText } from "./lib/io.ts";
import { openSubject } from "./lib/subject.ts";
import { targetKey, type Target } from "./lib/target.ts";
import { fingerprint } from "./lib/marker.ts";
import { compactDeletedFiles } from "./lib/hunks.ts";
import { SUBJECT, ARTIFACTS, RUNNER, MODEL, EFFORT, MODEL_WALK, MODEL_MERGE, EFFORT_AUX, WALK_BUDGET, PART_BUDGET, GROUPING, SLICE_BUDGET, MERGE_BUDGET, POOL, MAX_SLICES, MAX_SLICE_TOKENS, WALK_DIFF_TOKENS, OUT, applyConfig, setRunState, resetRunState, releaseSubject, type ReviewConfig } from "./config.ts";
import { classifyFile, type Finding } from "./findings.ts";
import { gitText, diffOutline, gatherIntent, gatherPriorComments, renderPriorComments, type PriorComment } from "./context.ts";
import { agent, CancelledError, killAgents } from "./runner.ts";
import { slicePrompt, mergePrompt, type ReviewUnit, coverUnits, packUnits, type Walkthrough, partitionPrompt, groupNamingPrompt, walkthroughPrompt } from "./prompts.ts";
import { classifySurface, SURFACE_RANK, CONF, SEV } from "./surface.ts";
import { saidFingerprints, readCheckedClaims, mergeBudgetFor, fallbackRank, coordinatorHasWork, type MergeDecisions, MAX_POSTED, applyDecisions } from "./coordinate.ts";
import { writeArtifacts } from "./render.ts";

export * from "./config.ts";
export * from "./findings.ts";
export * from "./context.ts";
export * from "./runner.ts";
export * from "./prompts.ts";
export * from "./surface.ts";
export * from "./coordinate.ts";
export * from "./render.ts";

// ---------------------------------------------------------------- API

export type ReviewStage =
  | "resolving_target"
  | "checking_registry"
  | "building_map"
  | "grouping"
  | "reviewing"
  | "coordinating"
  | "walkthrough"
  | "verifying"
  | "writing";

export type ReviewEvent =
  | { type: "stage"; stage: ReviewStage }
  | {
    type: "slice";
    index: number;
    total: number;
    title: string;
    status: "started" | "ok" | "failed";
    costUsd?: number;
    wallMs?: number;
    findings?: number;
  }
  | { type: "log"; message: string }
  /** Running total after every agent call. */
  | { type: "cost"; totalUsd: number }
  /** Slices stopped being started because the running total reached `maxCostUsd`. */
  | { type: "budget"; totalUsd: number; limitUsd: number; skippedSlices: number }
  /** The review units, known once grouping finishes and before any slice starts. */
  | { type: "units"; units: ReviewUnit[]; byClass: RunReviewResult["byClass"] };

export interface RunReviewOptions {
  /** The local clone that supplies the git object store. */
  repo: string;
  target: Target;
  /** Extra statement of intent: the body when there is no PR, appended to the PR body otherwise. */
  intent?: string;
  tag: string;
  onProgress?: (event: ReviewEvent) => void;
  config?: Partial<ReviewConfig>;
  /** The review is read locally and never posted. See `writeArtifacts`. */
  local?: boolean;
  /**
   * Findings from an earlier local review of the same target, as the bot's own
   * comments. They get the treatment its posted comments get on a pull request:
   * not reported again, and closed out in `resolved` when fixed.
   */
  prior?: PriorComment[];
  /** Aborting kills every running agent and makes runReview throw CancelledError. */
  signal?: AbortSignal;
  /**
   * Stop starting slices once the running total reaches this. Checked between
   * slices only, so slices already running and the coordinator and walkthrough
   * still spend.
   */
  maxCostUsd?: number;
}

export interface RunReviewResult {
  /** The run record written to runs/<tag>.json, or null when nothing was reviewable. */
  record: Record<string, unknown> | null;
  units: ReviewUnit[];
  byClass: { skip: string[]; docs: string[]; code: string[] };
  findings: Finding[];
  costUsd: number;
  wallMs: number;
  markdownPath: string;
}

/**
 * Run one review. Module-level state (SUBJECT, repoName, the config lets) is
 * shared, so only one review may run per process at a time.
 */
export async function runReview(options: RunReviewOptions): Promise<RunReviewResult> {
  if (options.config) applyConfig(options.config);
  const { signal } = options;
  if (signal?.aborted) throw new CancelledError();
  const onAbort = () => void killAgents();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal) setRunState({ signal });
  try {
    return await main(options);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await killAgents();
    await releaseSubject();
    resetRunState();
  }
}

// ---------------------------------------------------------------- driver

async function main(options: RunReviewOptions): Promise<RunReviewResult> {
  const emit = (e: ReviewEvent) => options.onProgress?.(e);
  const { signal, maxCostUsd } = options;
  const checkAbort = () => {
    if (signal?.aborted) throw new CancelledError();
  };
  let spent = 0;
  const addCost = (usd: number) => {
    spent += usd;
    emit({ type: "cost", totalUsd: spent });
  };
  emit({ type: "stage", stage: "resolving_target" });
  const HOME_REPO = options.repo;
  const { pr, base, head, slug } = options.target;
  // Artifacts are keyed on the pull request when there is one, and on the range
  // otherwise, so two ranges reviewed in the same clone do not overwrite each
  // other's run record or repo map.
  const mapKey = targetKey({ pr, base, head });
  const tagBase = options.tag;
  const markdownPath = path.join(ARTIFACTS, "reviews", `${tagBase}.md`);

  await ensureDir(OUT);
  for (const d of ["runs", "raw", "logs", "prompts", "reviews", "maps"]) {
    await ensureDir(path.join(ARTIFACTS, d));
  }
  // Self-ignoring, so a review never dirties the tree it is reviewing and the
  // repository's own .gitignore does not need to know this directory exists.
  await writeText(path.join(ARTIFACTS, ".gitignore"), "*\n");

  const subject = await openSubject(HOME_REPO, pr, head);
  setRunState({ subject: subject.dir, releaseSubject: subject.release });

  const started = Date.now();

  // ---- context, shared by every slice
  setRunState({ repoName: slug });
  const intent = await gatherIntent(slug, pr, base, head);
  if (options.intent) intent.body = intent.body ? `${intent.body}\n\n${options.intent}` : options.intent;
  const prior = [...(await gatherPriorComments(slug, pr)), ...(options.prior ?? [])];
  const priorMd = renderPriorComments(prior, intent.body);

  // Counted for the run record.
  const reviewsSoFar = Math.max(0, ...prior.filter((c) => c.mine).map((c) => c.runs ?? 0));

  checkAbort();
  emit({ type: "stage", stage: "checking_registry" });
  const reg = await registryCheck({ repo: SUBJECT, base, head });
  const regMd = renderRegistryReport(reg.findings);

  const mapPath = path.join(ARTIFACTS, "maps", `${mapKey}.md`);
  let mapNote = "";
  let haveMap = await exists(mapPath);
  emit({ type: "stage", stage: "building_map" });
  if (!haveMap) {
    // The map is an accelerant, not a requirement: it makes reviews cheaper at
    // equal finding quality. If the tree-sitter grammars are missing, reviewing
    // without it beats not reviewing at all.
    try {
      const built = await buildDiffSeededMap({ repo: SUBJECT, base, head });
      await writeText(mapPath, built.markdown);
        await writeJson(path.join(ARTIFACTS, "maps", `${mapKey}.meta.json`), built.meta);
      haveMap = true;
    } catch (err) {
      console.error(`repo map unavailable, continuing without it: ${err}`);
    }
  }
  if (haveMap) {
    mapNote = `A repository orientation map for this change is at \`${mapPath}\`. Read it first (use tilth_read if available) to get your bearings before exploring — it lists the codebase layout, the symbols in each changed file, and the files that import or are imported by them.\n`;
  }

  checkAbort();
  // ---- slices
  const changed = (await gitText(["diff", "--name-only", `${base}..${head}`])).trim().split("\n").filter(Boolean);
  const byClass = { skip: [] as string[], docs: [] as string[], code: [] as string[] };
  for (const f of changed) byClass[classifyFile(f)].push(f);
  const sliceFiles = byClass.code;

  // `git diff <range> -- ` with an empty pathspec means "everything", not
  // "nothing". A docs-only or lockfile-only change leaves no code files, and
  // without this the planner would be handed the entire diff of the repository
  // and asked to partition it. There is nothing here to review.
  if (sliceFiles.length === 0) {
    console.error(`  ${changed.length} changed files, none reviewable — no review`);
    await writeArtifacts({
      dir: path.join(ARTIFACTS, "reviews"), tag: tagBase, slug, pr, base, head,
      findings: [],
      stats: { "changed files": String(changed.length), reviewed: "nothing: no code files in this change" },
      repoDir: SUBJECT,
      local: options.local,
    });
    // Having nothing to say is not the same as having looked and found nothing.
    // Without this, a markdown-only pull request gets a comment announcing that
    // there was nothing to review, which is noise of exactly the kind this bot
    // exists to stop producing. The preview above is still written, so a local
    // run can see what was skipped.
    return { record: null, units: [], byClass, findings: [], costUsd: 0, wallMs: Date.now() - started, markdownPath };
  }

  emit({ type: "stage", stage: "grouping" });
  // ---- partition: group the changed files into flows. This is the only model
  // call on the critical path before reviewing starts, so it gets a cheap model,
  // a small budget, and an instruction not to read the repository. Its grouping
  // *is* the work breakdown: files that must agree with each other go to one
  // reviewer, and prose goes to nobody. The reviewer-facing prose is written
  // later, off the critical path, once the findings exist.
  const partTag = `${tagBase}-part`;
  const partOut = `${OUT}/${partTag}.json`;
  await removeIfPresent(partOut);
  // Links are computed whichever way units are formed: they also tell each
  // reviewer which of its files are tied to files another reviewer has.
  const { wholeDiff, diffstat, diffU0, fileTokens, facts, links, grouping } = await groupChanges({
    base,
    head,
    files: sliceFiles,
    source: () => projectFilesFromGit(SUBJECT),
  });
  const outline = await diffOutline(base, head, sliceFiles);
  const computed = GROUPING === "code" ? grouping : undefined;
  const pp = computed
    ? groupNamingPrompt({ groups: computed.groups, links, outline, intent, registry: regMd, outFile: partOut })
    : partitionPrompt({ diffstat, outline, intent, codeFiles: sliceFiles, registry: regMd, outFile: partOut });
  await writeText(path.join(ARTIFACTS, "prompts", `${partTag}.txt`), pp);
  // A single computed group needs no name beyond the pull request's own title,
  // so the call is skipped.
  const singleGroup = computed?.groups.length === 1;
  let parted = { wallMs: 0, costUsd: 0, numTurns: 0, payload: undefined as unknown };
  if (!singleGroup) {
    parted = await agent(pp, {
      budget: PART_BUDGET, outFile: partOut, tag: partTag, model: MODEL_WALK, effort: EFFORT_AUX,
    });
    addCost(parted.costUsd);
  }
  checkAbort();

  let groupMoves: ReturnType<typeof applyGroupNaming>["moves"] = [];
  let units: ReviewUnit[];
  if (computed && singleGroup) {
    units = [{ id: computed.groups[0].id, title: intent.title || computed.groups[0].id, files: computed.groups[0].files, priority: 1 }];
  } else if (computed) {
    const named = applyGroupNaming(computed.groups, parted.payload as GroupNaming | undefined, MAX_SLICE_TOKENS, fileTokens);
    groupMoves = named.moves;
    units = coverUnits(named.units, sliceFiles);
    for (const m of groupMoves) console.error(`  moved ${m.file}: ${m.from} -> ${m.to} (${m.reason})`);
  } else {
    const partition = (parted.payload ?? undefined) as { review_units?: ReviewUnit[] } | undefined;
    units = coverUnits(partition?.review_units ?? [], sliceFiles);
  }

  // A file the registry check flagged is the whole reason that check exists, so
  // its unit jumps the queue rather than being dropped by the slice cap. Beyond
  // that, longest-first: the pool's makespan is set by when the biggest unit
  // starts, and diff size is the only size signal available before running it.
  // This ordering ranks units; packing below turns them into sized slices.
  const flagged = new Set(reg.findings.map((f) => f.addedIn));
  const unitSize = new Map<string, number>(
    units.map((u) => [u.id, u.files.reduce((a, f) => a + (fileTokens.get(f) ?? 0), 0)]),
  );
  const ordered0 = [...units].sort((a, b) => {
    const fa = Number(a.files.some((f) => flagged.has(f)));
    const fb = Number(b.files.some((f) => flagged.has(f)));
    if (fa !== fb) return fb - fa;
    const pa = a.priority ?? 5, pb = b.priority ?? 5;
    if (pa !== pb) return pa - pb;
    return (unitSize.get(b.id) ?? 0) - (unitSize.get(a.id) ?? 0);
  });
  // Round-robin across units: the first share of every unit before the second
  // share of any. The cap is a cost limit, and spending all of it going deep on
  // the largest unit while never opening the others is the wrong trade — a unit
  // exists because it is a distinct mechanism, and one look at each is worth
  // more than seven looks at one.
  const unitRank = new Map(ordered0.map((u, i) => [u.id, i]));
  const packed = packUnits(ordered0, fileTokens, MAX_SLICE_TOKENS).sort(
    (a, b) => a.part - b.part || (unitRank.get(a.unitId) ?? 0) - (unitRank.get(b.unitId) ?? 0),
  );
  const capped = packed.slice(0, MAX_SLICES);
  const notReviewed = packed.slice(MAX_SLICES).flatMap((s) => s.files);
  const oversized = capped.filter((s) => s.tokens > MAX_SLICE_TOKENS);

  console.error(
    `${pr ? `PR ${pr} ` : ""}${base.slice(0, 8)}..${head.slice(0, 8)} — ${changed.length} changed ` +
      `(${sliceFiles.length} code, ${byClass.docs.length} docs, ${byClass.skip.length} skipped) ` +
      `-> ${units.length} units, ${capped.length} slices` +
        `${notReviewed.length ? `, ${notReviewed.length} files over cap` : ""}` +
        `${oversized.length ? `, ${oversized.length} over ${MAX_SLICE_TOKENS} tokens` : ""}` +
        `, registry signals: ${reg.findings.length}, prior comments: ${prior.length}`,
  );
  for (const s of capped) {
    console.error(
      `  slice ${s.unitId}${s.parts > 1 ? ` ${s.part}/${s.parts}` : ""} ` +
        `(${s.tokens} tokens): ${s.files.join(", ")}`,
    );
  }

  const sliceRuns: Record<string, unknown>[] = [];
  const allFindings: Finding[] = [];
  // Indexed by slice so the list reads in slice order, not completion order.
  const checkedBySlice: string[][] = [];

  emit({ type: "units", units, byClass });
  emit({ type: "stage", stage: "reviewing" });
  let cursor = 0;
  let budgetStopped = false;
  let budgetSkipped: string[] = [];
  async function worker(id: number) {
    while (true) {
      if (signal?.aborted) return;
      if (maxCostUsd !== undefined && spent >= maxCostUsd && cursor < capped.length) {
        const rest = capped.slice(cursor);
        cursor = capped.length;
        budgetStopped = true;
        budgetSkipped = rest.flatMap((s) => s.files);
        console.error(`  cost $${spent.toFixed(2)} reached --max-cost $${maxCostUsd.toFixed(2)}: ${rest.length} slice(s) not started`);
        emit({ type: "budget", totalUsd: spent, limitUsd: maxCostUsd, skippedSlices: rest.length });
        return;
      }
      const i = cursor++;
      if (i >= capped.length) return;
      const slice = capped[i];
      // The reviewer is handed the slice as if it were the unit: its own share of
      // the files, and a title that says which part of the mechanism this is. The
      // unit id is what findings are attributed to, so a split unit still reads as
      // one mechanism everywhere downstream.
      const unit: ReviewUnit = {
        id: slice.unitId,
        title: slice.title,
        rationale: slice.rationale,
        files: slice.files,
        priority: slice.priority,
      };
      const tag = `${tagBase}-s${String(i).padStart(2, "0")}`;
      const diff = compactDeletedFiles(await gitText(["diff", `${base}..${head}`, "--", ...slice.files]), base);
      if (!diff.trim()) continue;
      const outFile = `${OUT}/${tag}.json`;
      await removeIfPresent(outFile);
      const prompt = slicePrompt({
        unit, diff, intent, registry: regMd, prior: priorMd, mapNote, outFile,
        crossLinks: crossLinksFor(slice.files, links),
      });
      await writeText(path.join(ARTIFACTS, "prompts", `${tag}.txt`), prompt);
      const sliceEvent = { type: "slice", index: i, total: capped.length, title: slice.title } as const;
      emit({ ...sliceEvent, status: "started" });
      // A slice that exits non-zero or writes nothing is recorded and tolerated;
      // only a rejection escaped that, and it is the path a missing agent
      // binary or an EPIPE takes. Letting it out rejects the Promise.all, which
      // unwinds into the top-level finally and force-removes the worktree while
      // the other slices are still running inside it.
      let r: Awaited<ReturnType<typeof agent>>;
      try {
        r = await agent(prompt, { budget: SLICE_BUDGET, outFile, tag });
        addCost(r.costUsd);
      } catch (error) {
        console.error(`  [w${id}] ${slice.unitId} — failed to run: ${error instanceof Error ? error.message : String(error)}`);
        sliceRuns.push({
          unit: slice.unitId, part: slice.part, parts: slice.parts, tokens: slice.tokens,
          files: slice.files, tag,
          wallMs: 0, costUsd: 0, numTurns: 0,
          exitCode: -1, findingCount: 0, ok: false,
        });
        emit({ ...sliceEvent, status: "failed" });
        continue;
      }
      // Shape-checked rather than trusted. An agent that writes `findings` as an
      // object, or an array of strings, produces something `for...of` throws on
      // — and that throw is outside the guard above, so it rejects the
      // Promise.all and the top-level finally force-removes the worktree while
      // the other slices are still reading from it. A malformed file costs its
      // own slice, not the run.
      const payload = r.payload as { findings?: unknown } | unknown[] | null;
      const listed = Array.isArray(payload) ? payload : (payload?.findings ?? []);
      const raw = (Array.isArray(listed) ? listed : []).filter(
        (f): f is Finding => typeof f === "object" && f !== null,
      );
      if (raw.length !== (Array.isArray(listed) ? listed.length : 0)) {
        console.error(`  [w${id}] ${slice.unitId} — discarded malformed entries from the findings file`);
      }
      for (const f of raw) {
        f._slice = slice.unitId;
        allFindings.push(f);
      }
      const sliceChecked = readCheckedClaims(r.payload);
      checkedBySlice[i] = sliceChecked;
      sliceRuns.push({
        unit: slice.unitId, part: slice.part, parts: slice.parts, tokens: slice.tokens,
        files: slice.files, tag,
        wallMs: r.wallMs, costUsd: r.costUsd, numTurns: r.numTurns,
        // Kept because every comparison between runners or efforts needs it and
        // the run record is the only artifact retained long enough to compare.
        // Without it the token counts live solely in the raw stdout dump.
        usage: r.usage,
        tools: r.tools,
        checked: sliceChecked,
        exitCode: r.exitCode, findingCount: raw.length,
        // "The reviewer looked and found nothing" and "the reviewer never ran"
        // are the same empty array downstream. This is what tells them apart.
        //
        // The delivered file decides it, not the exit code. A reviewer that
        // reports three findings and is then stopped for running over budget
        // has reviewed the code; three of five slices scored as failures on one
        // large pull request had each delivered findings, and the OpenCode
        // governor's last-resort abort exits non-zero by construction. An exit
        // code says how the process ended, which is a different question.
        ok: r.payload !== null,
      });
      console.error(
        `  [w${id}] ${slice.unitId}${slice.parts > 1 ? ` ${slice.part}/${slice.parts}` : ""} ` +
          `(${slice.files.length}f ${slice.tokens}t) — ${(r.wallMs / 1000).toFixed(0)}s $${r.costUsd.toFixed(2)} ` +
          `${r.numTurns}t ${raw.length} findings`,
      );
      emit({
        ...sliceEvent, status: r.payload !== null ? "ok" : "failed",
        costUsd: r.costUsd, wallMs: r.wallMs, findings: raw.length,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, capped.length) }, (_, i) => worker(i)));
  // Killed slices deliver nothing and would otherwise read as failures below.
  checkAbort();

  // A run where every slice failed produces zero findings, which renders as a
  // clean review. With a bad or unfunded API key that is the *only* thing that
  // happens: the job exits 0 and posts an all-clear on a pull request nothing
  // read. Failing here is the difference between a red build and a false
  // assurance. `ok` may be absent on records reused via MERGE_ONLY, which
  // predate this field, and those fall back to the exit code.
  const okSlices = sliceRuns.filter((r) => (r.ok as boolean | undefined) ?? r.exitCode === 0);
  if (sliceRuns.length > 0 && okSlices.length === 0) {
    throw new Error(
      `all ${sliceRuns.length} review slices failed — no review was produced. ` +
        `Run \`diffloupe doctor\` to check credentials, and see the agent output in ` +
        `${path.join(ARTIFACTS, "raw")} and ${path.join(ARTIFACTS, "logs")}`,
    );
  }
  if (okSlices.length < sliceRuns.length) {
    console.error(`  warning: ${sliceRuns.length - okSlices.length} of ${sliceRuns.length} slices failed`);
  }

  // ---- pre-trim before the coordinator
  // The coordinator's cost is driven by how many findings it must open code to
  // verify. On a wide diff the low-confidence tail is both the largest share of
  // that bill and the least likely to survive, so it is cut deterministically.
  let toMerge = allFindings;
  if (allFindings.length > 20) {
    toMerge = allFindings.filter(
      (f) => !(f.severity === "nice-to-have" && f.confidence !== "high"),
    );
  }
  const preTrimmed = allFindings.length - toMerge.length;

  // ---- merge / verify
  const mergeTag = `${tagBase}-merge`;
  const mergeOut = `${OUT}/${mergeTag}.json`;
  await removeIfPresent(mergeOut);
  const mp = mergePrompt({ findings: toMerge, intent, files: sliceFiles, prior: priorMd, outFile: mergeOut });
  await writeText(path.join(ARTIFACTS, "prompts", `${mergeTag}.txt`), mp);
  const mergeBudget = mergeBudgetFor(toMerge.length, MERGE_BUDGET);

  // The reviewer's guide is prose about the diff. It reads the raw findings to
  // learn where the risk turned out to be, but not the coordinator's verdict on
  // them, so it does not have to wait for one. Running it beside the coordinator
  // keeps it off the critical path entirely.
  const walkTag = `${tagBase}-walk`;
  const walkOut = `${OUT}/${walkTag}.json`;
  await removeIfPresent(walkOut);
  // Whole files only: cutting mid-file left the guide describing a function
  // whose body it could not see. Units, not slices: a unit split across three
  // reviewers is still one mechanism, and that is the level the guide's
  // chapters are written at.
  const walkUnits = ordered0.filter((u) => capped.some((s) => s.unitId === u.id));
  const inWalkUnit = new Set(walkUnits.flatMap((u) => u.files));
  const unreviewed = packed.flatMap((s) => s.files).filter((f) => !inWalkUnit.has(f));
  const walkGroups = [...walkUnits, ...(unreviewed.length ? [{ files: [...new Set(unreviewed)] }] : [])];
  const { shown: walkFiles, sketched: walkOmitted } = selectWalkFiles(walkGroups, fileTokens, WALK_DIFF_TOKENS);
  const walkTokens = walkFiles.reduce((a, f) => a + (fileTokens.get(f) ?? 0), 0);
  const walkDiff = walkOmitted.length
    ? compactDeletedFiles(await gitText(["diff", `${base}..${head}`, "--", ...walkFiles]), base)
    : wholeDiff;
  if (walkOmitted.length) {
    console.error(
      `  walkthrough sees ${walkFiles.length} of ${sliceFiles.length} files (${walkTokens} tokens), ` +
        `${walkOmitted.length} given as sketches`,
    );
  }
  const sketches = sketchFiles(diffU0, facts);
  const wp = walkthroughPrompt({
    diffstat,
    diff: walkDiff,
    sketches: walkOmitted.map((f) => sketchLine(sketches.get(f) ?? { file: f, added: 0, removed: 0, defines: [], touches: [] })),
    crossLinks: crossGroupLinkLines(walkUnits, links),
    intent,
    findingIndex: toMerge.map((f) => `- [${f.severity}] ${f.file}:${f.line} — ${f.title}`).join("\n"),
    unitSummary: walkUnits
      .map((u) => {
        const linked = groupLinkLines(u.files, links);
        return (
          `**${u.title}** (${u.id})\n${u.files.map((f) => `  - ${f}`).join("\n")}` +
          (linked.length ? `\n  Links: ${linked.join("; ")}` : "")
        );
      })
      .join("\n\n"),
    docsFiles: byClass.docs,
    registry: regMd,
    outFile: walkOut,
  });
  await writeText(path.join(ARTIFACTS, "prompts", `${walkTag}.txt`), wp);

  // Every slice has already been paid for by this point. `agent()` rejects on a
  // spawn error or an EPIPE writing the prompt, and these are the two largest
  // prompts in the run, so letting a rejection out would throw away the whole
  // review over the last two calls. A failed merge falls through to the
  // deterministic fallback below; a failed walkthrough just omits the guide.
  const survive = (tag: string) => (error: unknown) => {
    console.error(`  ${tag} failed to run: ${error instanceof Error ? error.message : String(error)}`);
    return { wallMs: 0, exitCode: -1, costUsd: 0, numTurns: 0, usage: null, payload: null };
  };
    const skipped = { wallMs: 0, exitCode: 0, costUsd: 0, numTurns: 0, usage: null, payload: null };
    const mergeIdle = !coordinatorHasWork(toMerge, prior);
    if (mergeIdle) console.error("  coordinator skipped: no findings and no earlier comments to close out");
    emit({ type: "stage", stage: "coordinating" });
    emit({ type: "stage", stage: "walkthrough" });
    const [merged, walked] = await Promise.all([
      mergeIdle
        ? Promise.resolve({ ...skipped, payload: { keep: [] } satisfies MergeDecisions })
        : agent(mp, { budget: mergeBudget, outFile: mergeOut, tag: mergeTag, model: MODEL_MERGE, effort: EFFORT_AUX })
          .then((r) => (addCost(r.costUsd), r))
          .catch(survive("coordinator")),
      agent(wp, { budget: WALK_BUDGET, outFile: walkOut, tag: walkTag, model: MODEL_WALK, effort: EFFORT_AUX })
        .then((r) => (addCost(r.costUsd), r))
        .catch(survive("walkthrough")),
    ]);
  checkAbort();
  const walkthrough = (walked.payload ?? undefined) as Walkthrough | undefined;
  const mp2 = (merged.payload ?? {}) as MergeDecisions;

  let finalFindings: Finding[] = [];
  let coordinatorDropped: { title: string; reason: string }[] = [];
  let mergeMode = mergeIdle ? "nothing-to-merge" : "coordinator";

  // ---- deterministic suppression of things already said
  const alreadySaid = saidFingerprints(prior);
  // Run before the cap, not after. The slices re-find the same top-ranked
  // problems on every push, so on a re-review the head of the list is largely
  // repeats. Capping first spends the ten slots on findings that are then
  // deleted, and nothing promotes the eleventh into a slot the third vacated —
  // the review shrinks by the number of repeats instead of showing what is new.
  const suppressSaid = (list: Finding[]) => {
    if (!alreadySaid.size) return list;
    return list.filter((f) => {
      const hit = alreadySaid.get(fingerprint(f.file, f.title));
      if (!hit) return true;
      coordinatorDropped.push({
        title: f.title,
        reason: `already posted on an earlier push (comment ${hit.id})`,
      });
      console.error(`  suppressed "${f.title}" — same claim as comment ${hit.id}`);
      return false;
    });
  };
  // Every claim this review stands behind, captured before either the cap or
  // suppression thins the list. Both of those remove findings the review still
  // believes in, and this set is what stops a comment being closed out as fixed
  // while the problem is still being reported.
  let stillOpen = new Set<string>();
  // Findings the review stands behind but did not post because of the cap.
  // Listed in the detail file, so a reader can see what the cut removed.
  let overCap: Finding[] = [];

  if (mp2.keep) {
    const applied = applyDecisions(mp2, toMerge, prior);
    // Seeded before `suppressSaid` runs, because that closure appends to this
    // binding. Assigning it afterwards would discard every suppression record
    // it just added, and `rejected` below is built from this array.
    coordinatorDropped = applied.dropped;
    const importance = (a: Finding, b: Finding) =>
      (SEV[a.severity]?.rank ?? 9) - (SEV[b.severity]?.rank ?? 9) ||
      SURFACE_RANK[classifySurface(a.file)] - SURFACE_RANK[classifySurface(b.file)] ||
      CONF.indexOf(a.confidence) - CONF.indexOf(b.confidence);
    const byImportance = applied.kept.sort(importance);
    // The cap is on new findings. Corroborations are rendered into the human's
    // own thread rather than posted as comments, and the coordinator was told
    // they are exempt — a flat slice here would let a batch of high-severity
    // agreements sort to the front and push real findings past the cut.
    stillOpen = new Set([...byImportance, ...applied.capped].map((f) => fingerprint(f.file, f.title)));
    const open = suppressSaid(byImportance);
    const echoes = open.filter((f) => f.repeat_of);
    const allFresh = open.filter((f) => !f.repeat_of);
    const fresh = allFresh.slice(0, MAX_POSTED);
    // The coordinator's own cap cuts rank below anything this cut leaves over,
    // and go through the same suppression so an already-posted claim is not
    // listed again as past the cap.
    overCap = [...allFresh.slice(MAX_POSTED), ...suppressSaid(applied.capped.sort(importance))];
    finalFindings = [...fresh, ...echoes].sort(importance);
  }
  if (!mp2.keep) {
    // The coordinator died (usually budget). Unverified findings beat no review.
    mergeMode = "deterministic-fallback";
    const ranked = fallbackRank(toMerge);
    stillOpen = new Set(ranked.map((f) => fingerprint(f.file, f.title)));
    // Suppressing before the cap matters most here. This path applies no model
    // filtering at all, so on a second push it would otherwise take ten
    // already-posted findings, delete all ten, and report that nothing was
    // found.
    //
    // `repeat_of` is stripped rather than assumed absent. A slice reviewer is
    // told to set it, so a raw finding can carry one, and vetting it is the
    // coordinator's job — which on this path is the thing that failed. An
    // unvetted id would route the finding out of the review and into a reply
    // endpoint that may not accept it, losing a finding this path exists to
    // salvage.
    const open = suppressSaid(ranked).map((f) => ({ ...f, repeat_of: undefined }));
    finalFindings = open.slice(0, MAX_POSTED);
    overCap = open.slice(MAX_POSTED);
  }

  // A comment cannot be both closed out as fixed and reported again in the same
  // review. The finding wins: the coordinator read the code for it, and claiming
  // a fix that is not there is the worse failure. This holds whether the finding
  // is posted or suppressed as a repeat — "you already said this" is not "the
  // code changed".
  const resolved = (mp2.resolved ?? []).filter((r) => {
    const c = prior.find((p) => p.id === r.id);
    if (!c?.mine) return false;
    // A close-out is delivered to `pulls/<pr>/comments/<id>/replies`, which only
    // accepts review comment ids. The prompt draws these ids from a section that
    // also prints the summary comment's id, and a summary comment is `mine` with
    // no `file` — sending one there is a 404, and the post job counts that as a
    // failed call and goes red. `file` is what distinguishes the two.
    if (!c.file) return false;
    return !(c.fingerprint && stillOpen.has(c.fingerprint));
  });
  if (resolved.length) console.error(`  closing out ${resolved.length} earlier comments as fixed`);

  emit({ type: "stage", stage: "verifying" });
  // ---- deterministic verification: cited location must exist
  const verified: Finding[] = [];
  const rejected: { title: string; reason: string }[] = [...coordinatorDropped];
  for (const f of finalFindings) {
    const abs = path.join(SUBJECT, f.file);
    const lineCount = await countLines(abs);
    if (lineCount === null) {
      rejected.push({ title: f.title, reason: `cited file does not exist: ${f.file}` });
      continue;
    }
    if (f.line < 1 || f.line > lineCount) {
      rejected.push({ title: f.title, reason: `cited line ${f.line} outside ${f.file} (${lineCount} lines)` });
      continue;
    }
    verified.push(f);
  }

  const notReviewedFiles = {
    overCap: notReviewed,
    failed: sliceRuns
      .filter((r) => !((r.ok as boolean | undefined) ?? r.exitCode === 0))
      .flatMap((r) => (r.files as string[] | undefined) ?? []),
    budget: budgetSkipped,
  };
  const checked = checkedBySlice.flat().filter(Boolean);
  const totalCost = sliceRuns.reduce((a, r) => a + (r.costUsd as number), 0) + merged.costUsd + walked.costUsd;
  const wallMs = Date.now() - started;

  const stats = {
    "review units": capped.length,
    "code files reviewed": capped.reduce((n, u) => n + u.files.length, 0),
    "docs files not reviewed": byClass.docs.length,
    "generated files skipped": byClass.skip.length,
    "raw findings": allFindings.length,
    "after merge": finalFindings.length,
    "after verification": verified.length,
    "registry signals": reg.findings.length,
    "prior comments considered": prior.length,
    "wall time": `${(wallMs / 60000).toFixed(1)} min`,
    cost: `$${totalCost.toFixed(2)}`,
    model: MODEL,
    ...(MODEL_MERGE !== MODEL ? { "coordinator model": MODEL_MERGE } : {}),
    "walkthrough model": MODEL_WALK,
    // "0 stops" reads as "nothing worth stopping at". When the guide produced
    // nothing at all, say so — that is a failed call, not a quiet diff.
    "walkthrough stops": walkthrough
      ? (walkthrough.chapters ?? []).reduce((n, c) => n + (c.stops?.length ?? 0), 0)
      : "none — the walkthrough produced no guide",
      ...(walkOmitted.length
        ? { "walkthrough did not read": `${walkOmitted.length} of ${sliceFiles.length} files` }
        : {}),
      ...(notReviewed.length ? { "not reviewed (over cap)": notReviewed.join(", ") } : {}),
      ...(budgetStopped ? { "not reviewed (cost limit)": budgetSkipped.join(", ") } : {}),
      // Cut before the coordinator ever saw them, so they appear in no other
      // drop accounting. Every other path that discards a finding records it.
      ...(preTrimmed ? { "trimmed before merge": `${preTrimmed} low-confidence nice-to-have` } : {}),
      // Stated in the posted review, not just the log: a reader who sees few
      // findings needs to know whether that is a clean bill or a partial run.
      ...(okSlices.length < sliceRuns.length
        ? { "slices that failed": `${sliceRuns.length - okSlices.length} of ${sliceRuns.length} — this review is incomplete` }
        : {}),
      // The fallback path skips the coordinator entirely, so nothing here was
      // checked against the code. A reader should weigh it differently.
      ...(mergeMode !== "coordinator" && mergeMode !== "nothing-to-merge" ? { merging: `${mergeMode} — findings are unverified` } : {}),
    };

  emit({ type: "stage", stage: "writing" });
  await writeArtifacts({
    dir: path.join(ARTIFACTS, "reviews"),
    tag: tagBase,
    slug, pr, base, head,
    findings: verified,
    intentAlignment: mp2.intent_alignment,
    dropped: rejected,
    stats,
    walkthrough,
    prior,
    resolved,
    runs: reviewsSoFar + 1,
    noReviewers: sliceRuns.length === 0,
    unreviewed: notReviewedFiles,
    checked,
    overCap,
    repoDir: SUBJECT,
    local: options.local,
  });

  const record: Record<string, unknown> = {
    // Effort is recorded alongside the model because it moves cost and findings
    // as much as the model does, and a stored run is the only evidence of which
    // configuration produced a given result.
    pr, base, head, runner: RUNNER, model: MODEL, effort: EFFORT, effortAux: EFFORT_AUX,
    models: { review: MODEL, coordinator: MODEL_MERGE, walkthrough: MODEL_WALK },
    tag: tagBase,
    wallMs, totalCostUsd: totalCost,
    mergeMode, preTrimmed, budgetStopped,
    sliceRuns,
    merge: {
      wallMs: merged.wallMs, costUsd: merged.costUsd, numTurns: merged.numTurns,
      tools: "tools" in merged ? merged.tools : undefined,
    },
    walk: { model: MODEL_WALK, wallMs: walked.wallMs, costUsd: walked.costUsd, numTurns: walked.numTurns },
    walkthrough: walkthrough ?? null,
    grouping: GROUPING,
    groupMoves,
    reviewUnits: capped,
    registry: { meta: reg.meta, findings: reg.findings },
    priorComments: prior.length,
    prior,
    rawFindings: allFindings,
    mergedFindings: finalFindings,
      verifiedFindings: verified,
      overCapFindings: overCap,
      checked,
      unreviewed: notReviewedFiles,
      resolved,
      runs: reviewsSoFar + 1,
      rejected,
    intentAlignment: mp2.intent_alignment ?? null,
    stats,
  };
  await writeJson(path.join(ARTIFACTS, "runs", `${tagBase}.json`), record);

  return { record, units, byClass, findings: verified, costUsd: totalCost, wallMs, markdownPath };
}
