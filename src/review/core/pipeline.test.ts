
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  anchorCovers,
  applyDecisions,
  capFindings,
  chooseReviewScope,
  classifyFile,
  classifySurface,
  condenseOwnSummary,
  coordinatorHasWork,
  coverUnits,
  describeSliceFailures,
  envNumber,
  fallbackRank,
  fitComment,
  groupByDir,
  insertCopyBlock,
  isConversationNoise,
  leadSentences,
  mergeBudgetFor,
  packUnits,
  primarySurface,
  readCheckedClaims,
  renderPriorComments,
  renderReview,
  saidFingerprints,
  openCodeConfig,
  openCodeInvocation,
  openCodeSettings,
  otherSites,
  resetOpenCodeConfig,
  runReview,
  sumOpenCodeStream,
  summarizeOpenCodeTools,
  type Finding,
  type PriorComment,
} from "./pipeline.ts";
import { diagnoseMissingOutput } from "./runner.ts";
import { readMarkers } from "./lib/marker.ts";
import { ARTIFACTS, OUT, applyConfig } from "./config.ts";

// Repo-specific surface patterns that the classifySurface assertions below rely on.
applyConfig({ surfaces: { deploy: ["^(infra|charts)/"], tooling: ["^(docs|toolchains)/"] } });

const priorComment = (over: Partial<PriorComment> = {}): PriorComment =>
  ({
    id: 1,
    author: "ai-review[bot]",
    body: "b",
    mine: true,
    ...over,
  }) as PriorComment;

const finding = (over: Partial<Finding> = {}): Finding =>
  ({
    file: "a.ts",
    line: 10,
    severity: "should-fix",
    category: "bug",
    title: "t",
    explanation: "e",
    evidence: "v",
    confidence: "high",
    ...over,
  }) as Finding;

/**
 * GitHub applies a suggestion to the lines the comment sits on, not the lines
 * the finding names. When a comment has been moved to reach the diff, those are
 * different, and clicking "Commit suggestion" rewrites the wrong lines. A
 * button that looks committable and corrupts the file is worse than no button.
 */
describe("anchorCovers", () => {
  it("offers the suggestion when the anchor is exactly the cited line", () => {
    expect(anchorCovers(finding({ _anchor: { kind: "anchorable", line: 10 } }))).toBe(true);
  });

  it("offers the suggestion when the anchor is exactly the cited span", () => {
    const f = finding({ line: 10, end_line: 14, _anchor: { kind: "anchorable", line: 14, start_line: 10 } });
    expect(anchorCovers(f)).toBe(true);
  });

  it("withholds it when a span was collapsed to one end", () => {
    const f = finding({ line: 10, end_line: 14, _anchor: { kind: "anchorable", line: 14 } });
    expect(anchorCovers(f)).toBe(false);
  });

  it("withholds it when the comment was moved to reach the diff", () => {
    expect(anchorCovers(finding({ _anchor: { kind: "off-hunk", line: 18 } }))).toBe(false);
  });

  it("withholds it for a finding rendered into the summary", () => {
    expect(anchorCovers(finding({ _anchor: { kind: "off-diff" } }))).toBe(false);
  });

  // With no anchor the payload uses the model's own line numbers, so the
  // comment and the replacement agree by construction.
  it("offers it when no anchoring was done", () => {
    expect(anchorCovers(finding())).toBe(true);
  });

  it("handles a span written backwards the way the anchor does", () => {
    const f = finding({ line: 14, end_line: 10, _anchor: { kind: "anchorable", line: 14, start_line: 10 } });
    expect(anchorCovers(f)).toBe(true);
  });
});

/**
 * Weighs a finding by what the changed file can break. Decides both the order
 * of the review and, through `primarySurface`, which findings are worth a
 * comment of their own.
 */
describe("classifySurface", () => {
  it("treats shipped code as product", () => {
    expect(classifySurface("src/processor/linker/search.ts")).toBe("product");
  });

  // Product is identified by exclusion, so a source root nobody listed still
  // lands in the right place. These are the ones that carry shipped bytes or
  // shape the production database.
  it("treats unlisted source roots as product", () => {
    expect(classifySurface("lib/7z.so")).toBe("product");
    expect(classifySurface("db/migrations/0001_init.sql")).toBe("product");
    expect(classifySurface("database/schema.sql")).toBe("product");
    expect(classifySurface("packages/protocol/ts/client/index.ts")).toBe("product");
    expect(classifySurface("proto/messages.proto")).toBe("product");
  });

  it("treats deployment description as deploy", () => {
    expect(classifySurface("infra/ecr.ts")).toBe("deploy");
    expect(classifySurface("charts/cost-rollup/values-prod.yaml")).toBe("deploy");
  });

  it("treats scripts and tests as tooling", () => {
    expect(classifySurface("scripts/code-review/pipeline.ts")).toBe("tooling");
    expect(classifySurface("src/processor/linker/branch-eviction-policy.test.ts")).toBe("tooling");
  });

  // CI describes how the change is built and checked, not what runs in
  // production. A broken workflow blocks a merge; it does not reach a user.
  it("treats CI configuration as tooling", () => {
    expect(classifySurface(".github/workflows/ai-code-review.yml")).toBe("tooling");
    expect(classifySurface(".buildkite/pipeline.yml")).toBe("tooling");
    expect(classifySurface("toolchains/cxx/BUCK")).toBe("tooling");
  });

  // Nothing loose in the repository root is shipping code — it is a manifest or
  // a config. Without this, `package.json` alone makes a tooling-only change
  // look like it touches production.
  it("treats root-level files as tooling", () => {
    expect(classifySurface("package.json")).toBe("tooling");
    expect(classifySurface("vitest.config.mts")).toBe("tooling");
    expect(classifySurface("tsconfig.json")).toBe("tooling");
  });

  // The container image is what actually runs, so it is graded with deployment
  // even though it sits in the root where everything else is a config file.
  it("treats a root container definition as deploy", () => {
    expect(classifySurface("Dockerfile")).toBe("deploy");
    expect(classifySurface("Earthfile")).toBe("deploy");
  });
});

/**
 * Picks the surface a review is about: the most production-proximate one the
 * change touches at all. Presence rather than proportion, because a change that
 * fixes one line of shipping code and adds ten helper scripts is still a change
 * to shipping code.
 */
describe("primarySurface", () => {
  it("picks product when the change touches any shipping code", () => {
    const files = ["src/analysis/execution-data/analyzeExecutionData.ts", ...Array.from({ length: 37 }, (_, i) => `test/point-stack-${i}.test.ts`)];
    expect(primarySurface(files, [])).toBe("product");
  });

  it("picks tooling when nothing outside tooling changed", () => {
    expect(primarySurface(["scripts/code-review/pipeline.ts", "package.json", ".github/workflows/ai-code-review.yml"], [])).toBe("tooling");
  });

  it("picks deploy over tooling", () => {
    expect(primarySurface(["charts/cost-rollup/values-prod.yaml", "scripts/deploy.ts"], [])).toBe("deploy");
  });

  // The diff can fail to parse; the findings still name files, and reviewing
  // those is better than defaulting to the widest tier.
  it("falls back to the files the findings name", () => {
    expect(primarySurface([], [finding({ file: "scripts/code-review/post.ts" })])).toBe("tooling");
  });

  // No changed files and no findings means nothing to route. Product is the
  // safe answer: it is the widest tier, so it hides nothing.
  it("defaults to product when it knows nothing", () => {
    expect(primarySurface([], [])).toBe("product");
  });
});

/**
 * Conversation comments are context, not review feedback. They are worth
 * reading — a stated constraint holds the code to something the diff alone does
 * not show — but the pull request description pasted into a comment and a bot
 * directive are neither.
 */
describe("isConversationNoise", () => {
  const description = "This pull request replaces the code review bot. ".repeat(20);

  it("keeps a comment that raises a concern", () => {
    expect(isConversationNoise("Does this still work when the cache is cold?", description)).toBe(false);
  });

  it("keeps a short human comment", () => {
    expect(isConversationNoise("LGTM", description)).toBe(false);
  });

  // A directive is a mention and a command word. Matching any short comment
  // that opens with a mention drops one person asking another to look at
  // something, which is exactly the context this section carries.
  it("keeps a mention addressed to a person", () => {
    expect(isConversationNoise("@markerikson can you take a look at the second commit?", description)).toBe(false);
    expect(isConversationNoise("@markerikson this breaks the cold cache path", description)).toBe(false);
  });

  it("drops an empty comment", () => {
    expect(isConversationNoise("", description)).toBe(true);
    expect(isConversationNoise("   \n  ", description)).toBe(true);
  });

  it("drops a bot directive", () => {
    expect(isConversationNoise("@SocketSecurity ignore-all", description)).toBe(true);
    expect(isConversationNoise("@dependabot rebase", description)).toBe(true);
  });

  // The author pasting the description into a comment would otherwise arrive as
  // discussion the reviewers are told to weigh.
  it("drops the description pasted back as a comment", () => {
    expect(isConversationNoise(description, description)).toBe(true);
  });

  it("keeps a short comment that happens to appear in the description", () => {
    expect(isConversationNoise("code review bot", description)).toBe(false);
  });
});

/**
 * A close-out reply carries the path of the comment it answers, so it satisfies
 * the "is a review comment" test that separates findings from conversation.
 * `addressed` lands on the comment being answered and never on the answer, so
 * without an explicit exclusion the bot's own "✅ Fixed as of …" reply survives
 * both filters and is handed to the next run as a prior finding whose entire
 * content is that something else was fixed.
 */
describe("renderPriorComments own-inline section", () => {
  const openFinding = priorComment({ id: 10, file: "a.ts", line: 3, body: "the open finding" });
  const closeOut = priorComment({
    id: 11,
    file: "a.ts",
    line: 3,
    body: "Fixed as of abc1234",
    inReplyTo: 10,
  });

  it("excludes the bot's own replies", () => {
    const out = renderPriorComments([openFinding, closeOut]);
    expect(out).toContain("id=10");
    expect(out).not.toContain("id=11");
  });

  it("still lists the bot's own unaddressed thread-starting comments", () => {
    expect(renderPriorComments([openFinding])).toContain("id=10");
  });

  it("excludes an own comment the author has since addressed", () => {
    const done = priorComment({ id: 12, file: "a.ts", line: 3, addressed: true });
    expect(renderPriorComments([done])).not.toContain("id=12");
  });

  /**
   * The prior summary is forwarded so the next run can see what it demoted and
   * what it already rejected. Those sections sit at the end of the comment,
   * after the findings list, so a cap sized for the old evidence-carrying
   * summary cuts off exactly the part this block exists to pass on. The largest
   * summary across the stored runs is 10.4k.
   */
  it("forwards the conclusions at the end of a full-size prior summary", () => {
    const filler = "- a finding bullet that takes up room\n".repeat(250);
    const summary = priorComment({
      id: 13,
      body: `## Findings\n${filler}\n#### Findings considered and dropped\n- the rejected one`,
    });
    const out = renderPriorComments([summary]);
    expect(out).toContain("Findings considered and dropped");
    expect(out).toContain("the rejected one");
  });
});

/**
 * The summary comment carries the claims; a linked file carries the argument.
 *
 * The risk this guards is not cosmetic. Every check for "have I said this
 * already" reads the posted comment and nothing else, and the fingerprints used
 * to live at the end of the evidence block that moved into the file. A finding
 * whose marker went with it would be invisible to repeat suppression, and the
 * bot would report it again on every push — the exact failure that retired the
 * previous bot, where 40-50% of its output was restatement.
 */
describe("renderReview detail split", () => {
  const base = { head: "abc1234567", stats: {}, repo: "o/r" };
  const walkthrough = {
    intent: {
      alignment: "aligned" as const,
      inferred: "INFERRED_PROSE that runs on past the truncation point.",
    },
    focus: "the eviction path",
    start_here: [{ file: "src/a.ts", why: "the new entry point" }],
    chapters: [
      {
        title: "Eviction",
        stops: [{ title: "the sweep", prose: "SWEEP_PROSE", locations: [{ file: "src/a.ts", line: 4 }] }],
      },
    ],
  };

  it("keeps a fingerprint in the comment for every finding it lists", () => {
    const findings = [
      finding({ file: "src/a.ts", title: "first claim", explanation: "long argument here" }),
      finding({ file: "src/b.ts", title: "second claim", explanation: "another argument" }),
    ];
    const out = renderReview({ ...base, findings });
    const fps = readMarkers(out.summary).filter((m) => m.kind === "summary-item");
    expect(fps).toHaveLength(2);
    expect(new Set(fps.map((m) => m.fields.fp)).size).toBe(2);
  });

  it("shows the other copies of a defect outside the collapsed sections", () => {
    const out = renderReview({
      ...base,
      findings: [finding({ file: "src/a.ts", title: "uses url.origin", also_at: ["src/b.ts:7", "src/c.ts:9"] })],
    });
    const text = JSON.stringify(out);
    const at = text.indexOf("Same problem at: `src/b.ts:7`, `src/c.ts:9`");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(text.indexOf("<summary>Why this is a problem</summary>", text.indexOf("uses url.origin\\n")));
  });

  it("lists the other copies of a defect on its summary bullet", () => {
    const out = renderReview({
      ...base,
      findings: [finding({ file: "src/a.ts", title: "uses url.origin", also_at: ["src/b.ts:7", "src/c.ts:9"] })],
    });
    const bullet = out.summary.split("\n").find((l) => l.includes("uses url.origin"));
    expect(bullet).toContain(" · also `src/b.ts:7`, `src/c.ts:9` · ");
    expect(readMarkers(out.summary).filter((m) => m.kind === "summary-item")).toHaveLength(1);
  });

  it("folds findings below the posting threshold into their own section, with no inline comment", () => {
    const findings = [
      finding({ file: "src/a.ts", title: "real bug", severity: "should-fix" }),
      finding({ file: "src/a.ts", title: "style nit", severity: "nice-to-have" }),
      finding({ file: "src/b.ts", title: "why this way", severity: "question" }),
    ];
    const out = renderReview({ ...base, findings, inlineMode: "tier", changedFiles: ["src/a.ts", "src/b.ts"], minSeverity: "should-fix" });
    const fold = out.summary.indexOf("<details><summary>Minor findings (2) — below should-fix</summary>");
    expect(fold).toBeGreaterThan(-1);
    expect(out.summary.indexOf("real bug")).toBeLessThan(fold);
    expect(out.summary.indexOf("style nit")).toBeGreaterThan(fold);
    expect(out.summary.indexOf("why this way")).toBeGreaterThan(fold);
    expect(out.ordered.map((f) => f.title)).toEqual(["real bug"]);
    // The folded findings keep their fingerprints so the next review does not raise them again.
    expect(readMarkers(out.summary).filter((m) => m.kind === "summary-item")).toHaveLength(2);
  });

  it("lists every severity together without a threshold", () => {
    const findings = [finding({ file: "src/a.ts", title: "style nit", severity: "nice-to-have" })];
    expect(renderReview({ ...base, findings }).summary).not.toContain("Minor findings");
  });

  /**
   * The badge comes from the walkthrough call and the sentence from the
   * coordinator, issued concurrently. The coordinator writes its sentence only
   * when the diff diverges from the description, so a "matches" badge next to
   * it joins two contradicting judgements as if they were one.
   */
  it("does not render a matches badge next to a divergence sentence", () => {
    const out = renderReview({
      ...base,
      findings: [],
      walkthrough,
      intentAlignment: { summary: "The description says dry-run, the workflow posts live." },
    });
    expect(out.summary).not.toContain("✅ Matches the description");
    expect(out.summary).toContain("⚠️ Partly matches the description");
    expect(out.summary).toContain("the workflow posts live");
  });

  it("keeps the matches badge when the coordinator raised nothing", () => {
    const out = renderReview({ ...base, findings: [], walkthrough, intentAlignment: {} });
    expect(out.summary).toContain("✅ Matches the description");
  });

  /**
   * Zero findings means two opposite things: the reviewers looked and found
   * nothing, or nobody looked. A walkthrough-only run produces the second, and
   * an all-clear on an unreviewed diff is the worst output this pipeline can
   * emit.
   */
  it("does not claim a clean diff when no reviewer ran", () => {
    const looked = renderReview({ ...base, findings: [], walkthrough });
    expect(looked.summary).toContain("No new issues found");

    const out = renderReview({ ...base, findings: [], walkthrough, noReviewers: true });
    expect(out.summary).not.toContain("No new issues found");
    expect(out.summary).toContain("No reviewer ran on this change");
  });

  it("says outside the fold when part of the diff was not reviewed", () => {
    const out = renderReview({
      ...base,
      findings: [],
      walkthrough,
      unreviewed: { overCap: ["src/x.ts"], failed: ["src/y.ts", "src/z.ts"] },
    });
    const visible = out.summary.split("<details>")[0];
    expect(visible).toContain("⚠️ **Partial review:** 3 changed code files were not reviewed");
    expect(visible).toContain("1 over the slice cap, 2 in a reviewer that failed");
    expect(visible).toContain("`src/y.ts`, `src/z.ts`, `src/x.ts`");
    expect(visible).toContain("No new issues found in the reviewed files.");
    expect(visible).not.toContain("in the changed files");
  });

  it("shows what was checked when there is little else to show", () => {
    const checked = Array.from({ length: 10 }, (_, i) => `claim ${i}`);
    const out = renderReview({ ...base, findings: [], walkthrough, checked });
    const fold = "<details><summary>What the reviewers checked (10)</summary>";
    expect(out.summary).toContain(fold);
    expect(out.summary.indexOf(fold)).toBeGreaterThan(out.summary.indexOf("Full walkthrough"));
    expect(out.summary).toContain("- claim 7");
    expect(out.summary).not.toContain("- claim 8");
    expect(out.summary).toContain("…and 2 more in the detail file");
    expect(out.detail).toContain("- claim 9");
  });

  it("leaves the checked list to the detail file when there are several findings", () => {
    const findings = ["a", "b", "c"].map((t, i) => finding({ file: `src/${t}.ts`, line: i + 1, title: t }));
    const out = renderReview({ ...base, findings, checked: ["claim"] });
    expect(out.summary).not.toContain("What the reviewers checked");
    expect(out.detail).toContain("## What the reviewers checked");
  });

  it("does not show a checked list when no reviewer ran", () => {
    const out = renderReview({ ...base, findings: [], walkthrough, noReviewers: true, checked: ["claim"] });
    expect(out.summary).not.toContain("What the reviewers checked");
  });

  it("counts findings past the cap and lists them in the detail file", () => {
    const findings = [finding({ file: "src/a.ts", title: "posted" })];
    const overCap = [finding({ file: "src/b.ts", title: "CUT_ONE" }), finding({ file: "src/c.ts", title: "CUT_TWO" })];
    const out = renderReview({ ...base, findings, overCap });
    expect(out.summary).toContain("2 more findings past the 10-finding cap");
    expect(out.summary).not.toContain("CUT_ONE");
    expect(out.detail).toContain("## Past the cap");
    expect(out.detail).toContain("CUT_ONE");
    expect(out.detail).toContain("CUT_TWO");
  });

  it("moves the argument out of the comment and into the detail file", () => {
    const findings = [finding({ file: "src/a.ts", title: "a claim", explanation: "THE_ARGUMENT" })];
    const out = renderReview({ ...base, findings });
    // The claim is scannable in the comment; the reasoning is one link away.
    expect(out.summary).toContain("a claim");
    expect(out.summary).not.toContain("THE_ARGUMENT");
    expect(out.detail).toContain("THE_ARGUMENT");
  });

  it("keeps start here in the comment and the chapter tour in the file", () => {
    const out = renderReview({ ...base, findings: [finding({})], walkthrough });
    expect(out.summary).toContain("Start here");
    expect(out.summary).toContain("the new entry point");
    expect(out.summary).toContain("the eviction path");
    expect(out.summary).not.toContain("SWEEP_PROSE");
    expect(out.detail).toContain("SWEEP_PROSE");
  });

  /**
   * A reader opening this on a push is asking "did it find anything", not "what
   * is this change". Orientation prose above the findings makes them scroll past
   * a description of their own pull request to reach the answer.
   */
  it("puts the findings above the orientation prose", () => {
    const findings = [finding({ file: "src/a.ts", title: "the claim" })];
    const out = renderReview({ ...base, findings, walkthrough });
    const claim = out.summary.indexOf("the claim");
    const focus = out.summary.indexOf("What to focus on");
    const start = out.summary.indexOf("Start here");
    expect(claim).toBeGreaterThan(-1);
    expect(focus).toBeGreaterThan(claim);
    expect(start).toBeGreaterThan(claim);
    // Intent, then what it does, then where to look, then what to open.
    expect(out.summary.indexOf("**Intent:**")).toBeLessThan(focus);
    expect(focus).toBeLessThan(start);
    // Still below the risk verdicts, which are the one-line version of the same
    // question and stay at the very top.
    expect(out.summary.indexOf("Merge risk")).toBeLessThan(claim);
  });

  it("names the artifact to download when it runs in Actions", () => {
    const before = process.env.GITHUB_RUN_ID;
    process.env.GITHUB_RUN_ID = "998877";
    try {
      const out = renderReview({ ...base, pr: "13204", findings: [finding({})], detailFile: "ci-13204.detail.md" });
      expect(out.summary).toContain("actions/runs/998877");
      expect(out.summary).toContain("ci-13204.detail.md");
    } finally {
      if (before === undefined) delete process.env.GITHUB_RUN_ID;
      else process.env.GITHUB_RUN_ID = before;
    }
  });

  it("points at the file on disk when there is no run to link", () => {
    const before = process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ID;
    try {
      const out = renderReview({
        ...base,
        findings: [finding({})],
        detailFile: "local.detail.md",
        detailPath: "/data/artifacts/reviews/local.detail.md",
      });
      expect(out.summary).toContain("`/data/artifacts/reviews/local.detail.md`");
      expect(out.summary).not.toContain("actions/runs");
    } finally {
      if (before !== undefined) process.env.GITHUB_RUN_ID = before;
    }
  });
});

/**
 * Only the tier earns an inline comment. Everything below it still appears as a
 * summary bullet with a permalink and an evidence block, so the finding is not
 * dropped — it just stops arriving as a notification on a line. This is the
 * whole of what reduces comment volume; the surface split in the summary alone
 * changed nothing about how much the bot sends.
 */
describe("renderReview inline routing", () => {
  const base = { head: "abc1234567", stats: {}, repo: "o/r", inlineMode: "tier" as const };
  const anchored = (over: Partial<Finding>) =>
    finding({ _anchor: { kind: "anchorable", line: 10 }, ...over });

  it("comments only on the tier when a change touches shipping code", () => {
    const findings = [
      anchored({ file: "src/session/routines.ts", title: "prod one" }),
      anchored({ file: "scripts/code-review/pipeline.ts", title: "tooling one" }),
    ];
    const out = renderReview({ ...base, findings, changedFiles: ["src/session/routines.ts", "scripts/code-review/pipeline.ts"] });
    expect(out.ordered.map((f) => f.title)).toEqual(["prod one"]);
    expect(out.inline).toHaveLength(1);
    // Demoted, not discarded.
    expect(out.summary).toContain("tooling one");
  });

  it("comments on tooling findings when the change is only tooling", () => {
    const findings = [
      anchored({ file: "scripts/code-review/pipeline.ts", title: "tooling one" }),
      anchored({ file: "package.json", title: "manifest one" }),
    ];
    const out = renderReview({ ...base, findings, changedFiles: ["scripts/code-review/pipeline.ts", "package.json"] });
    expect(out.ordered).toHaveLength(2);
    expect(out.inline).toHaveLength(2);
  });

  // The verdict answers "can this break production", which stays false on a
  // tooling change however many findings were promoted into view.
  it("reports no prod risk on a tooling change that still posts comments", () => {
    const findings = [anchored({ file: "scripts/code-review/pipeline.ts", severity: "blocker" })];
    const out = renderReview({ ...base, findings, changedFiles: ["scripts/code-review/pipeline.ts"] });
    expect(out.inline).toHaveLength(1);
    expect(out.summary).toContain("Prod risk: none");
  });

  it("posts no inline comments by default", () => {
    const findings = [anchored({ file: "src/session/routines.ts", title: "prod one" })];
    const out = renderReview({
      head: "abc1234567",
      stats: {},
      repo: "o/r",
      findings,
      changedFiles: ["src/session/routines.ts"],
    });
    expect(out.inline).toHaveLength(0);
    expect(out.ordered).toHaveLength(0);
    // Still in the summary with its evidence number.
    expect(out.summary).toContain("prod one");
  });

  /**
   * A fingerprint has exactly one home. An inline comment carries it itself, so
   * a bullet marker on top would make the next run's prompt list the same claim
   * both as "do not repeat" and as "report again if still true".
   */
  it("puts the fingerprint on the bullet only when there is no inline comment", () => {
    const findings = [
      anchored({ file: "src/session/routines.ts", title: "prod one" }),
      anchored({ file: "scripts/code-review/pipeline.ts", title: "tooling one" }),
    ];
    const out = renderReview({ ...base, findings, changedFiles: ["src/session/routines.ts", "scripts/code-review/pipeline.ts"] });
    const claims = readMarkers(out.summary).filter((m) => m.kind === "summary-item");
    expect(claims.map((m) => m.fields.file)).toEqual(["scripts/code-review/pipeline.ts"]);
  });

  it("puts a fingerprint on every bullet in summary-only mode", () => {
    const findings = [
      anchored({ file: "src/session/routines.ts", title: "prod one" }),
      anchored({ file: "scripts/code-review/pipeline.ts", title: "tooling one" }),
    ];
    const out = renderReview({ ...base, inlineMode: "none", findings, changedFiles: ["src/session/routines.ts", "scripts/code-review/pipeline.ts"] });
    const claims = readMarkers(out.summary).filter((m) => m.kind === "summary-item");
    expect(claims).toHaveLength(2);
  });
});

/**
 * A close-out is posted to `pulls/<pr>/comments/<id>/replies`, which only
 * accepts review comment ids. The summary is an issue comment, and its id is put
 * in front of the coordinator in the same prompt section it draws `resolved` ids
 * from, so naming it is a mistake the coordinator can actually make. The reply
 * would 404, and the send is not marked recoverable, so the posting job fails.
 */
describe("renderReview close-out replies", () => {
  const base = { head: "abc1234567", findings: [], stats: {}, repo: "o/r" };

  it("skips a resolved id that names a comment with no thread to reply into", () => {
    const summary = priorComment({ id: 20, body: "summary comment" });
    const out = renderReview({ ...base, prior: [summary], resolved: [{ id: 20 }] });
    expect(out.replies).toHaveLength(0);
  });

  it("still closes out a real review comment", () => {
    const inline = priorComment({ id: 21, file: "a.ts", line: 3 });
    const out = renderReview({ ...base, prior: [inline], resolved: [{ id: 21 }] });
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0]!.comment_id).toBe(21);
  });

  it("skips a resolved id that names another author's comment", () => {
    const human = priorComment({ id: 22, author: "someone", mine: false, file: "a.ts", line: 3 });
    const out = renderReview({ ...base, prior: [human], resolved: [{ id: 22 }] });
    expect(out.replies).toHaveLength(0);
  });
});

/**
 * The mechanical half of "say a thing once". The prompt asks for the same
 * behaviour and cannot be trusted with it: the previous bot was asked, and
 * 40-50% of its output was restatement of comments it had already posted.
 */
describe("saidFingerprints", () => {
  /**
   * The summary is rewritten from scratch every run, so treating a bullet in it
   * as "already said" deletes the finding from the only place it exists. The run
   * after that reads a summary without the claim and reports it as new, and the
   * finding flickers on alternate pushes. An inline comment has no such problem:
   * it stays on the pull request whether this run mentions it or not.
   */
  it("does not treat a summary bullet as said, because suppressing it deletes it", () => {
    const summary = priorComment({
      id: 30,
      body: "summary comment",
      summaryClaims: [{ fp: "aaaaaaaaaa", file: "src/a.ts", line: "4" }],
    });
    expect(saidFingerprints([summary]).has("aaaaaaaaaa")).toBe(false);
  });

  it("remembers a finding that got its own inline comment", () => {
    const inline = priorComment({ id: 31, file: "src/a.ts", line: 4, fingerprint: "bbbbbbbbbb" });
    expect(saidFingerprints([inline]).has("bbbbbbbbbb")).toBe(true);
  });

  it("forgets an inline finding the author has since addressed", () => {
    const done = priorComment({ id: 32, file: "src/a.ts", fingerprint: "cccccccccc", addressed: true });
    expect(saidFingerprints([done]).has("cccccccccc")).toBe(false);
  });

  it("ignores claims in another author's comment", () => {
    const human = priorComment({
      id: 33,
      author: "someone",
      mine: false,
      summaryClaims: [{ fp: "dddddddddd", file: "src/a.ts", line: "4" }],
    });
    expect(saidFingerprints([human]).size).toBe(0);
  });
});

/**
 * Deciding a file is not worth a slice is irreversible and silent: nothing
 * downstream reports that a file was never reviewed.
 */
describe("classifyFile", () => {
  it("skips generated and vendored content", () => {
    expect(classifyFile("pnpm-lock.yaml")).toBe("skip");
    expect(classifyFile("web/dist/app.min.js")).toBe("skip");
    expect(classifyFile("src/__snapshots__/render.snap")).toBe("skip");
  });

  it("treats prose as docs", () => {
    expect(classifyFile("docs/architecture.md")).toBe("docs");
    expect(classifyFile("README.md")).toBe("docs");
    expect(classifyFile("LICENSE")).toBe("docs");
  });

  it("recognizes prose that is not at the repository root", () => {
    expect(classifyFile("packages/protocol/LICENSE")).toBe("docs");
  });

  it("sends source to review", () => {
    expect(classifyFile("src/shared/error.ts")).toBe("code");
    expect(classifyFile("src/native/linker/Manifest.cpp")).toBe("code");
  });

  it("does not mistake source for prose because of what it is named", () => {
    expect(classifyFile("scripts/code-review/lib/markdown.ts")).toBe("code");
    expect(classifyFile("src/shared/licenseCheck.ts")).toBe("code");
  });
});

/**
 * This is what the next run reads back as "what you already told this author".
 * The summary used to carry the whole walkthrough and every finding's full
 * argument, and the collapsed blocks were stripped to cut it down. The argument
 * now lives in the detail file, and what is left behind a `<details>` is
 * conclusions the next run needs.
 */
describe("condenseOwnSummary", () => {
  it("keeps the findings it routed out of the inline set", () => {
    const body = [
      "### Review",
      "<details><summary>Everything else (2)</summary>",
      "",
      "- `scripts/x.ts`",
      "  - Nice to have Unused binding",
      "</details>",
    ].join("\n");
    expect(condenseOwnSummary(body)).toContain("Unused binding");
  });

  it("keeps the list of things it considered and dropped", () => {
    const body = "<details><summary>Also considered (1)</summary>\n\n- Off-by-one — not real\n</details>";
    expect(condenseOwnSummary(body)).toContain("not real");
  });

  it("removes the machine markers, which are identity and not prose", () => {
    const body = "- a finding <!-- ai-review:summary-item fp=abc123 file=x.ts -->\n";
    const out = condenseOwnSummary(body);
    expect(out).toContain("a finding");
    expect(out).not.toContain("fp=abc123");
  });

  it("closes up the gaps the markers leave behind", () => {
    const body = "one\n\n<!-- m -->\n\n\n\ntwo\n\n";
    expect(condenseOwnSummary(body)).toBe("one\n\ntwo");
  });

  it("drops the copy-all-findings section, block or pointer", () => {
    const summary = "### Review\n\n- Should fix: Null case\n\n<details><summary>Review details</summary>\n\nstats\n</details>";
    const withBlock = insertCopyBlock(summary, "### [should-fix] Null case\n\nThe full argument.\n\n```ts\n</details>\n```");
    expect(withBlock).toContain("The full argument.");
    const condensed = condenseOwnSummary(withBlock);
    expect(condensed).not.toContain("Copy all findings");
    expect(condensed).not.toContain("The full argument.");
    expect(condensed).toBe("### Review\n\n- Should fix: Null case\n\n<details><summary>Review details</summary>\n\nstats\n</details>");

    const withPointer = insertCopyBlock(summary, "x".repeat(500), { limit: summary.length + 300 });
    expect(withPointer).toContain("too long for this comment");
    expect(condenseOwnSummary(withPointer)).toBe(condenseOwnSummary(summary));
  });
});

/** Truncating mid-clause reads as a bug in the bot rather than a length limit. */
describe("leadSentences", () => {
  it("leaves text that already fits", () => {
    expect(leadSentences("Short enough.", 100)).toBe("Short enough.");
  });

  it("takes as many whole sentences as fit and stops at a boundary", () => {
    const out = leadSentences("One sentence here. Two sentence here. Three sentence here.", 40);
    expect(out).toBe("One sentence here. Two sentence here.");
  });

  it("does not treat a dot inside a filename as the end of a sentence", () => {
    const out = leadSentences("The bug is in call-mcp.ts and it matters. A second sentence.", 45);
    expect(out).toBe("The bug is in call-mcp.ts and it matters.");
  });

  it("returns one long sentence whole rather than ending mid-clause", () => {
    const long = `${"a".repeat(50)}.`;
    expect(leadSentences(`${long} And a second.`, 20)).toBe(long);
  });
});

/**
 * GitHub rejects an oversized comment outright. The marker is what lets the next
 * run find this comment and rewrite it, so losing it in the cut would not fail
 * loudly — it would post a second comment on every push.
 */
describe("fitComment", () => {
  const tail = "\n<!-- ai-review:summary runs=3 -->";

  it("leaves a comment that already fits exactly as it was", () => {
    const body = `hello${tail}`;
    expect(fitComment(body, tail)).toBe(body);
  });

  it("brings an oversized comment inside the limit", () => {
    const body = `${"x".repeat(80000)}${tail}`;
    expect(fitComment(body, tail).length).toBeLessThanOrEqual(65536);
  });

  it("keeps the marker that lets the next run find this comment", () => {
    const body = `${"x".repeat(80000)}${tail}`;
    expect(fitComment(body, tail).endsWith(tail)).toBe(true);
  });

  it("says it was truncated rather than just ending", () => {
    const body = `${"x".repeat(80000)}${tail}`;
    expect(fitComment(body, tail)).toContain("Truncated");
  });

  it("closes a collapsed block the cut left open, so it does not swallow the notice", () => {
    const body = `<details><summary>s</summary>\n\n${"y".repeat(80000)}\n</details>${tail}`;
    const out = fitComment(body, tail);
    const open = (out.match(/<details/g) ?? []).length;
    const closed = (out.match(/<\/details>/g) ?? []).length;
    expect(closed).toBe(open);
    expect(out.indexOf("Truncated")).toBeGreaterThan(out.lastIndexOf("</details>"));
  });
});

/**
 * The planner's grouping is a suggestion; covering the diff is not. A file it
 * drops is never reviewed and nothing downstream notices.
 */
describe("coverUnits", () => {
  const files = ["src/a.ts", "src/b.ts", "src/c.ts"];

  it("reviews every changed file exactly once", () => {
    const units = coverUnits([{ id: "u1", title: "T", files: ["src/a.ts"] }], files);
    expect(units.flatMap((u) => u.files).sort()).toEqual(files);
  });

  it("removes a path the planner invented", () => {
    const units = coverUnits(
      [{ id: "u1", title: "T", files: ["src/a.ts", "src/imaginary.ts"] }],
      files,
    );
    expect(units[0].files).toEqual(["src/a.ts"]);
    expect(units.flatMap((u) => u.files)).not.toContain("src/imaginary.ts");
  });

  it("pays for a double-assigned file once, in the first unit that claimed it", () => {
    const units = coverUnits(
      [
        { id: "u1", title: "T", files: ["src/a.ts", "src/b.ts"] },
        { id: "u2", title: "T", files: ["src/b.ts", "src/c.ts"] },
      ],
      files,
    );
    expect(units[0].files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(units[1].files).toEqual(["src/c.ts"]);
  });

  it("does not run a unit with nothing left in it", () => {
    const units = coverUnits(
      [
        { id: "u1", title: "T", files: ["src/a.ts", "src/b.ts", "src/c.ts"] },
        { id: "u2", title: "T", files: ["src/a.ts"] },
      ],
      files,
    );
    expect(units.map((u) => u.id)).toEqual(["u1"]);
  });

  it("sweeps what the planner left out into a unit of its own", () => {
    const units = coverUnits([{ id: "u1", title: "T", files: ["src/a.ts"] }], files);
    const orphan = units.find((u) => u.id === "unassigned");
    expect(orphan?.files).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("reviews everything as one unit rather than nothing when the planner fails", () => {
    const units = coverUnits([], files);
    expect(units).toHaveLength(1);
    expect(units[0].files).toEqual(files);
  });

  it("reviews everything as one unit when the planner named only files that do not exist", () => {
    const units = coverUnits([{ id: "u1", title: "T", files: ["src/imaginary.ts"] }], files);
    expect(units).toHaveLength(1);
    expect(units[0].files).toEqual(files);
  });
});

/**
 * Runs only after the coordinator has already died, so this is the least
 * exercised path in the pipeline and the one whose bugs stay invisible until the
 * run that needs it.
 */
describe("fallbackRank", () => {
  it("reports a location once when several slices found the same thing", () => {
    const out = fallbackRank([
      finding({ file: "src/a.ts", line: 10, title: "one" }),
      finding({ file: "src/a.ts", line: 10, title: "the same place, said again" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("one");
  });

  it("drops an unverified suggestion the reviewer was not sure about", () => {
    const out = fallbackRank([
      finding({ severity: "nice-to-have", confidence: "low", file: "src/a.ts" }),
    ]);
    expect(out).toHaveLength(0);
  });

  it("keeps a nice-to-have the reviewer was confident about", () => {
    const out = fallbackRank([
      finding({ severity: "nice-to-have", confidence: "high", file: "src/a.ts" }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("puts the most severe finding first", () => {
    const out = fallbackRank([
      finding({ severity: "question", file: "src/a.ts", line: 1, title: "q" }),
      finding({ severity: "blocker", file: "src/b.ts", line: 2, title: "b" }),
    ]);
    expect(out[0].title).toBe("b");
  });

  it("puts shipping code above tooling when the severity is the same", () => {
    const out = fallbackRank([
      finding({ file: "scripts/t.ts", line: 1, title: "tooling" }),
      finding({ file: "src/p.ts", line: 2, title: "product" }),
    ]);
    expect(out.map((f) => f.title)).toEqual(["product", "tooling"]);
  });
});

/**
 * A flat cap on the coordinator is a cap on the wrong quantity: one measured run
 * spent sixteen dollars on slices and then returned nothing at all, because the
 * coordinator was cut off mid-pass and took every finding it had cleared with it.
 */
describe("mergeBudgetFor", () => {
  it("spends the floor on a small review", () => {
    expect(mergeBudgetFor(4, 3)).toBe(3);
  });

  it("grows with the number of findings to verify", () => {
    expect(mergeBudgetFor(30, 3)).toBeCloseTo(6.6);
  });

  it("stops growing, so a huge diff cannot run up an unbounded bill", () => {
    expect(mergeBudgetFor(500, 3)).toBe(9);
  });
});

describe("envNumber", () => {
  const name = "REVIEW_TEST_ENV_NUMBER";
  afterEach(() => {
    delete process.env[name];
  });

  it("falls back when unset or blank", () => {
    expect(envNumber(name, 6)).toBe(6);
    process.env[name] = "  ";
    expect(envNumber(name, 6)).toBe(6);
  });

  it("parses a number with surrounding whitespace", () => {
    process.env[name] = " 2.5 ";
    expect(envNumber(name, 6)).toBe(2.5);
  });

  it.each(["abc", "0", "-1", "Infinity"])("rejects %j", (raw) => {
    process.env[name] = raw;
    expect(() => envNumber(name, 6)).toThrow(name);
  });
});

describe("coordinatorHasWork", () => {
  const own = (over: Partial<PriorComment> = {}) =>
    priorComment({ id: 700, author: "bot", mine: true, file: "src/a.ts", ...over });

  it("has nothing to do with no findings and no earlier comments", () => {
    expect(coordinatorHasWork([], [])).toBe(false);
  });

  it("runs whenever there is a finding to rule on", () => {
    expect(coordinatorHasWork([finding({})], [])).toBe(true);
  });

  it("runs to close out the bot's own earlier review comments", () => {
    expect(coordinatorHasWork([], [own()])).toBe(true);
  });

  it("ignores comments it cannot close out", () => {
    const human = priorComment({ id: 701, author: "andarist", mine: false, file: "src/a.ts" });
    const summary = own({ file: undefined });
    const settled = own({ addressed: true });
    expect(coordinatorHasWork([], [human, summary, settled])).toBe(false);
  });
});

/**
 * The coordinator rules on numbered findings rather than rewriting them, so this
 * is where its judgement gets laid back over the reviewer's text. It is also the
 * only place `repeat_of` is checked before a finding is routed out of the review
 * and into a reply on someone else's thread.
 */
describe("applyDecisions", () => {
  const raw = [
    finding({ file: "src/a.ts", line: 10, title: "first" }),
    finding({ file: "src/b.ts", line: 20, title: "second" }),
    finding({ file: "src/c.ts", line: 30, title: "third" }),
  ];

  it("posts the reviewer's write-up, not a retyped one", () => {
    const { kept } = applyDecisions({ keep: [{ id: 0 }] }, raw, []);
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe("first");
    expect(kept[0].explanation).toBe("e");
  });

  it("lets the coordinator overrule the reviewer's severity", () => {
    const { kept } = applyDecisions({ keep: [{ id: 0, severity: "blocker" }] }, raw, []);
    expect(kept[0].severity).toBe("blocker");
  });

  it("adds the coordinator's note to what the reviewer wrote", () => {
    const { kept } = applyDecisions({ keep: [{ id: 0, note: "verified" }] }, raw, []);
    expect(kept[0].explanation).toBe("e\n\nverified");
  });

  it("lists a repeated copy's location next to the finding", () => {
    const { kept } = applyDecisions({ keep: [{ id: 0, repeats: [1] }] }, raw, []);
    expect(kept).toHaveLength(1);
    expect(kept[0].also_at).toEqual(["src/b.ts:20"]);
    expect(kept[0].cross_file_refs).toBeUndefined();
  });

  it("keeps a merged sibling's location as a supporting reference only", () => {
    const { kept } = applyDecisions({ keep: [{ id: 0, merge_with: [1] }] }, raw, []);
    expect(kept).toHaveLength(1);
    expect(kept[0].also_at).toBeUndefined();
    expect(kept[0].cross_file_refs).toEqual(["src/b.ts:20"]);
  });

  it("carries every repeated copy's other locations, without repeating its own", () => {
    const withSites = [
      finding({ file: "src/a.ts", line: 10, title: "first", also_at: ["src/d.ts:4"] }),
      finding({ file: "src/b.ts", line: 20, title: "second", also_at: ["src/a.ts:10", "src/d.ts:4", "src/e.ts:5"] }),
    ];
    const { kept } = applyDecisions({ keep: [{ id: 0, repeats: [1] }] }, withSites, []);
    expect(kept[0].also_at).toEqual(["src/d.ts:4", "src/b.ts:20", "src/e.ts:5"]);
  });

  it("does not also post a finding it listed as a repeat", () => {
    const { kept } = applyDecisions({ keep: [{ id: 0, repeats: [1] }, { id: 1 }] }, raw, []);
    expect(kept.map((f) => f.title)).toEqual(["first"]);
  });

  it("does not also post a finding it merged into another", () => {
    const { kept } = applyDecisions({ keep: [{ id: 0, merge_with: [1] }, { id: 1 }] }, raw, []);
    expect(kept.map((f) => f.title)).toEqual(["first"]);
  });

  it("ignores a decision about a finding that does not exist", () => {
    const { kept } = applyDecisions({ keep: [{ id: 99 }] }, raw, []);
    expect(kept).toHaveLength(0);
  });

  it("records why it dropped a finding", () => {
    const { dropped } = applyDecisions({ keep: [], drop: [{ id: 0, reason: "not real" }] }, raw, []);
    expect(dropped[0]).toEqual({ title: "first", reason: "not real" });
  });

  it("does not let silence pass for a decision", () => {
    const { dropped } = applyDecisions({ keep: [{ id: 0 }] }, raw, []);
    expect(dropped.map((d) => d.title)).toEqual(["second", "third"]);
    expect(dropped[0].reason).toContain("did not rule");
  });

  it("keeps findings cut for the cap apart from rejected ones", () => {
    const { dropped, capped } = applyDecisions(
      {
        keep: [{ id: 0 }],
        drop: [
          { id: 1, reason: "cap" },
          { id: 2, reason: "Cut for the cap" },
        ],
      },
      raw,
      [],
    );
    expect(capped.map((f) => f.title)).toEqual(["second", "third"]);
    expect(dropped).toEqual([]);
  });

  it("does not treat a reason that merely mentions capacity as the cap", () => {
    const { capped, dropped } = applyDecisions(
      { keep: [], drop: [{ id: 0, reason: "capacity check already exists" }] },
      raw.slice(0, 1),
      [],
    );
    expect(capped).toEqual([]);
    expect(dropped).toHaveLength(1);
  });

  describe("repeat_of", () => {
    const human = priorComment({ id: 500, author: "andarist", mine: false, file: "src/a.ts" });

    it("agrees with a human's review comment", () => {
      const { kept } = applyDecisions({ keep: [{ id: 0, repeat_of: 500 }] }, raw, [human]);
      expect(kept[0].repeat_of).toBe(500);
    });

    it("does not reply to a comment that is not on this pull request", () => {
      const { kept } = applyDecisions({ keep: [{ id: 0, repeat_of: 999 }] }, raw, [human]);
      expect(kept[0].repeat_of).toBeUndefined();
    });

    it("does not agree with itself", () => {
      const own = priorComment({ id: 501, mine: true, file: "src/a.ts" });
      const { kept } = applyDecisions({ keep: [{ id: 0, repeat_of: 501 }] }, raw, [own]);
      expect(kept[0].repeat_of).toBeUndefined();
    });

    it("does not reply into a conversation comment, which has no thread to accept it", () => {
      const issue = priorComment({ id: 502, author: "someone", mine: false });
      const { kept } = applyDecisions({ keep: [{ id: 0, repeat_of: 502 }] }, raw, [issue]);
      expect(kept[0].repeat_of).toBeUndefined();
    });

    it("strips one the reviewer set that the coordinator never ruled on", () => {
      const unvetted = [finding({ file: "src/a.ts", title: "first", repeat_of: 999 })];
      const { kept } = applyDecisions({ keep: [{ id: 0 }] }, unvetted, [human]);
      expect(kept[0].repeat_of).toBeUndefined();
    });

    it("keeps the finding itself when it refuses the agreement", () => {
      const { kept } = applyDecisions({ keep: [{ id: 0, repeat_of: 999 }] }, raw, [human]);
      expect(kept).toHaveLength(1);
      expect(kept[0].title).toBe("first");
    });
  });

  describe("preexisting", () => {
    const tagged = [finding({ title: "old", preexisting: true }), finding({ title: "new" })];

    it("keeps the reviewer's tag when the coordinator says nothing", () => {
      const { kept } = applyDecisions({ keep: [{ id: 0 }, { id: 1 }] }, tagged, []);
      expect(kept.map((f) => f.preexisting)).toEqual([true, undefined]);
    });

    it("lets the coordinator set or clear the tag", () => {
      const { kept } = applyDecisions(
        { keep: [{ id: 0, preexisting: false }, { id: 1, preexisting: true }] },
        tagged,
        [],
      );
      expect(kept.map((f) => f.preexisting)).toEqual([false, true]);
    });
  });
});

describe("otherSites", () => {
  it("keeps model-written locations that are strings and not the finding's own", () => {
    const f = { file: "src/a.ts", line: 10 };
    expect(otherSites(f, ["src/b.ts:2", "`src/c.ts:3`", 4, "", "src/a.ts:10", "src/b.ts:2"])).toEqual([
      "src/b.ts:2",
      "src/c.ts:3",
    ]);
    expect(otherSites(f, "src/b.ts:2")).toBeUndefined();
    expect(otherSites(f, ["src/a.ts:10"])).toBeUndefined();
  });
});

describe("capFindings", () => {
  const limits = { maxNew: 2, maxPreexisting: 1 };

  it("caps pre-existing findings apart from new ones", () => {
    const sorted = [
      finding({ title: "old 1", preexisting: true }),
      finding({ title: "new 1" }),
      finding({ title: "old 2", preexisting: true }),
      finding({ title: "new 2" }),
      finding({ title: "new 3" }),
    ];
    const { posted, overCap } = capFindings(sorted, limits);
    expect(posted.map((f) => f.title)).toEqual(["old 1", "new 1", "new 2"]);
    expect(overCap.map((f) => f.title)).toEqual(["old 2", "new 3"]);
  });

  it("never caps agreements with existing comments", () => {
    const sorted = [1, 2, 3].map((n) => finding({ title: `echo ${n}`, repeat_of: n }));
    const { posted, overCap } = capFindings(sorted, limits);
    expect(posted).toHaveLength(3);
    expect(overCap).toEqual([]);
  });
});

/**
 * The headline and the tally directly under it answer the same question, and a
 * reader who sees them disagree has no way to tell which one to believe.
 */
describe("renderReview merge-risk headline", () => {
  const base = { head: "abc1234567", stats: {}, repo: "o/r" };

  it("counts the same findings the severity tally does", () => {
    const findings = [
      finding({ file: "src/a.ts", title: "new one", severity: "should-fix" }),
      finding({ file: "src/b.ts", title: "agreeing one", severity: "should-fix", repeat_of: 7 }),
    ];
    const out = renderReview({ ...base, findings, changedFiles: ["src/a.ts", "src/b.ts"] });
    // One is an agreement with a human's existing comment: it appears in no
    // bullet list, so counting it in the headline points at nothing.
    expect(out.summary).toContain("1 should-fix finding open");
    expect(out.summary).toContain("**Should fix**: 1");
  });
});

describe("packUnits", () => {
  const unit = (id: string, files: string[]) => ({ id, title: id, files, priority: 3 });
  const tokens = (m: Record<string, number>) => new Map(Object.entries(m));

  it("leaves a unit that already fits as a single slice", () => {
    const out = packUnits([unit("u", ["a.ts", "b.ts"])], tokens({ "a.ts": 100, "b.ts": 200 }), 1000);
    expect(out).toHaveLength(1);
    expect(out[0].files).toEqual(["a.ts", "b.ts"]);
    expect(out[0].parts).toBe(1);
    expect(out[0].tokens).toBe(300);
    // A unit that never split should not be labelled as a part of anything.
    expect(out[0].title).toBe("u");
  });

  it("splits an oversized unit and says which part each slice is", () => {
    const out = packUnits(
      [unit("u", ["a.ts", "b.ts", "c.ts"])],
      tokens({ "a.ts": 600, "b.ts": 600, "c.ts": 600 }),
      1000,
    );
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.part)).toEqual([1, 2, 3]);
    expect(out.every((s) => s.parts === 3)).toBe(true);
    expect(out[0].title).toBe("u (part 1 of 3)");
  });

  it("keeps every file exactly once across the slices it produces", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const out = packUnits(
      [unit("u", files)],
      tokens({ "a.ts": 400, "b.ts": 300, "c.ts": 900, "d.ts": 100, "e.ts": 350 }),
      1000,
    );
    expect(out.flatMap((s) => s.files).sort()).toEqual([...files].sort());
  });

  it("gives a file bigger than the whole budget a slice to itself", () => {
    // Nothing can join it: every other file fails the fit test against a bin
    // that is already over budget, so it does not drag a neighbour down with it.
    const out = packUnits([unit("u", ["huge.ts", "small.ts"])], tokens({ "huge.ts": 5000, "small.ts": 10 }), 1000);
    const huge = out.find((s) => s.files.includes("huge.ts"))!;
    expect(huge.files).toEqual(["huge.ts"]);
    expect(huge.tokens).toBeGreaterThan(1000);
  });

  it("keeps the unit id on every slice, because findings attribute to the unit", () => {
    const out = packUnits([unit("engine", ["a.ts", "b.ts"])], tokens({ "a.ts": 900, "b.ts": 900 }), 1000);
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.unitId === "engine")).toBe(true);
  });

  it("packs each unit on its own rather than mixing two units into one slice", () => {
    const out = packUnits(
      [unit("one", ["a.ts"]), unit("two", ["b.ts"])],
      tokens({ "a.ts": 10, "b.ts": 10 }),
      1000,
    );
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.unitId).sort()).toEqual(["one", "two"]);
  });
});

describe("summarizeOpenCodeTools", () => {
  const call = (tool: string, input: Record<string, unknown>, status = "completed") =>
    JSON.stringify({ type: "tool_use", part: { type: "tool", tool, state: { status, input } } });

  it("counts calls and records what was read and searched", () => {
    const out = summarizeOpenCodeTools(
      [
        call("tilth_tilth_read", { path: "/work/src/a.ts", section: "10-26" }),
        call("tilth_tilth_read", { paths: ["/work/src/b.ts", "src/c.ts"] }),
        call("read", { path: "/work/src/a.ts" }),
        call("tilth_tilth_search", { query: "fooBar,bazQux" }),
        call("grep", { pattern: "TODO", path: "src" }),
        call("shell", { command: "git log -3" }, "error"),
        call("write", { path: "/out/s00.json", content: "{}" }),
        "not json",
        JSON.stringify({ type: "step_finish", part: { type: "step-finish", cost: 1 } }),
      ].join("\n"),
      "/work",
    );
    expect(out.calls).toEqual({ tilth_tilth_read: 2, read: 1, tilth_tilth_search: 1, grep: 1, shell: 1, write: 1 });
    expect(out.failed).toBe(1);
    expect(out.read).toEqual(["src/a.ts:10-26", "src/b.ts", "src/c.ts", "src/a.ts"]);
    expect(out.searched).toEqual(["fooBar,bazQux", "TODO"]);
  });

  it("caps the lists so a runaway reviewer cannot bloat the run record", () => {
    const lines = Array.from({ length: 200 }, (_, i) => call("read", { path: `f${i}.ts` }));
    const out = summarizeOpenCodeTools(lines.join("\n"));
    expect(out.calls.read).toBe(200);
    expect(out.read.length).toBeLessThan(200);
  });
});

describe("readCheckedClaims", () => {
  it("keeps up to four trimmed strings", () => {
    const out = readCheckedClaims({ findings: [], checked: [" a\n b ", 3, "", "c", "d", "e", "f"] });
    expect(out).toEqual(["a b", "c", "d", "e"]);
  });

  it("returns nothing for a bare array or a missing field", () => {
    expect(readCheckedClaims([{ file: "a.ts" }])).toEqual([]);
    expect(readCheckedClaims({ findings: [] })).toEqual([]);
    expect(readCheckedClaims(null)).toEqual([]);
    expect(readCheckedClaims({ checked: "not a list" })).toEqual([]);
  });

  it("shortens a claim too long for a comment bullet", () => {
    const [claim] = readCheckedClaims({ checked: ["x".repeat(1000)] });
    expect(claim.length).toBe(300);
    expect(claim.endsWith("…")).toBe(true);
  });
});

describe("sumOpenCodeStream", () => {
  const step = (cost: number, tokens: Record<string, unknown>, type = "step-finish") =>
    JSON.stringify({ type: "step_finish", part: { type, cost, tokens } });

  it("totals cost across steps, because the runner reports per step and not per run", () => {
    const out = sumOpenCodeStream(
      [step(0.5, { input: 10, output: 1 }), step(0.25, { input: 20, output: 2 })].join("\n"),
    );
    expect(out.costUsd).toBeCloseTo(0.75);
    expect(out.numTurns).toBe(2);
    expect(out.usage.input_tokens).toBe(30);
    expect(out.usage.output_tokens).toBe(3);
  });

  it("reports cache tokens separately, since a cached re-read is the cheap case", () => {
    const out = sumOpenCodeStream(step(0.1, { input: 5, cache: { read: 900, write: 40 } }));
    expect(out.usage.cache_read_input_tokens).toBe(900);
    expect(out.usage.cache_creation_input_tokens).toBe(40);
  });

  it("records the first step's prompt tokens on their own, to show whether the shared prefix hit the cache", () => {
    const out = sumOpenCodeStream(
      [
        step(0.1, { input: 7, cache: { read: 300, write: 50 } }),
        step(0.1, { input: 2, cache: { read: 900, write: 0 } }),
      ].join("\n"),
    );
    expect(out.usage.first_step).toEqual({
      input_tokens: 7,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 50,
    });
    expect(out.usage.cache_read_input_tokens).toBe(1200);
    expect(sumOpenCodeStream("").usage.first_step).toBeUndefined();
  });

  it("counts a step whichever separator the stream used in its name", () => {
    expect(sumOpenCodeStream(step(1, {}, "step_finish")).numTurns).toBe(1);
    expect(sumOpenCodeStream(step(1, {}, "step-finish")).numTurns).toBe(1);
  });

  it("ignores every event that is not a step, so text and tool calls are not turns", () => {
    const noise = [
      JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }),
      JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "read" } }),
      JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
    ].join("\n");
    const out = sumOpenCodeStream(noise);
    expect(out.numTurns).toBe(0);
    expect(out.costUsd).toBe(0);
  });

  it("skips unparseable lines rather than throwing, so a torn stream still accounts", () => {
    const out = sumOpenCodeStream(
      ["not json at all", "{ broken", "", step(0.4, { input: 7 })].join("\n"),
    );
    expect(out.costUsd).toBeCloseTo(0.4);
    expect(out.numTurns).toBe(1);
    expect(out.usage.input_tokens).toBe(7);
  });

  it("returns zeroes for an empty stream, which is what a failed spawn leaves", () => {
    const out = sumOpenCodeStream("");
    expect(out).toEqual({
      costUsd: 0,
      numTurns: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
  });
});

describe("openCodeInvocation", () => {
  const build = () =>
    openCodeInvocation("system prompt", {
      budget: 3,
      model: "claude-opus-5",
      effort: "medium",
      tag: "unit-pwd",
      outFile: "/tmp/unit-pwd-findings.json",
    });

  it("passes a wall-clock deadline to the governor, which the spend cap does not bound", async () => {
    // On a cheap model the budget never binds: one measured slice ran thirteen
    // minutes on a dime of a three dollar cap. Time is the only stage that stops it.
    const spec = await build();
    expect(Number(spec.env.REVIEW_GOVERNOR_DEADLINE_MS)).toBeGreaterThan(0);
  });

  it("points $PWD at the directory it spawns in, or the review reads the wrong checkout", async () => {
    // OpenCode resolves its project from $PWD, not from the process's working
    // directory. Inheriting the launching shell's value sent every slice of one
    // run to read the pipeline's own checkout while being shown the PR's diff.
    const spec = await build();
    expect(spec.env.PWD).toBe(spec.cwd);
  });

  it("names the model with its provider and effort variant, since a bare name does not resolve", async () => {
    const spec = await build();
    expect(spec.args).toContain("anthropic/claude-opus-5#medium");
    expect(spec.args).not.toContain("--variant");
  });

  it("runs a private server, so concurrent invocations cannot share one configuration", async () => {
    const spec = await build();
    expect(spec.args).toContain("--standalone");
  });

  it("asks the governor for usage totals, because the stream leaves out the final step", async () => {
    const spec = await build();
    expect(spec.env.REVIEW_GOVERNOR_USAGE_FILE).toContain("unit-pwd");
    expect(spec.env.REVIEW_GOVERNOR_WAIT_FOR_TOOLS).toBe("tilth_");
    expect(spec.env.REVIEW_GOVERNOR_EXPECT_TOOLS?.split(",")).toEqual(
      expect.arrayContaining(["tilth_tilth_search", "tilth_tilth_files"]),
    );
  });

  it("reads the governor's totals in preference to the stream", async () => {
    const spec = await build();
    const totals = {
      costUsd: 1.5,
      numTurns: 4,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        reasoning_tokens: 3,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 5,
      },
    };
    const file = spec.env.REVIEW_GOVERNOR_USAGE_FILE;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(totals));
    try {
      expect(spec.parse("")).toEqual(totals);
    } finally {
      rmSync(file, { force: true });
    }
    expect(spec.parse("").numTurns).toBe(0);
  });

  it("passes the budget to the governor rather than the binary, which has no such flag", async () => {
    const spec = await build();
    expect(spec.env.REVIEW_GOVERNOR_BUDGET_USD).toBe("3");
    expect(spec.args).not.toContain("--max-budget-usd");
  });

  it("clears the ambient config variables, so a developer's own setup cannot leak in", async () => {
    const spec = await build();
    expect(spec.unsetEnv).toContain("OPENCODE_CONFIG");
    expect(spec.unsetEnv).toContain("OPENCODE_CONFIG_CONTENT");
  });

  it("does not pass --pure, which would suppress the governor plugin with the rest", async () => {
    const spec = await build();
    expect(spec.args).not.toContain("--pure");
  });

  it("reuses one config directory across invocations, so the plugin install runs once", async () => {
    const first = await build();
    const second = await openCodeInvocation("system prompt", {
      budget: 3,
      model: "claude-opus-5",
      effort: "medium",
      tag: "unit-other-tag",
      outFile: "/tmp/unit-other-findings.json",
    });
    expect(second.env.OPENCODE_CONFIG_DIR).toBe(first.env.OPENCODE_CONFIG_DIR);
    // The per-invocation state still has to differ, or every slice would log
    // and report over the top of the last one.
    expect(second.env.REVIEW_GOVERNOR_OUT_FILE).not.toBe(first.env.REVIEW_GOVERNOR_OUT_FILE);
    expect(second.env.REVIEW_GOVERNOR_LOG).not.toBe(first.env.REVIEW_GOVERNOR_LOG);
  });

  it("gives every invocation its own data directory, because concurrent runs share a session database", async () => {
    const first = await build();
    const second = await openCodeInvocation("system prompt", {
      budget: 3,
      model: "claude-opus-5",
      effort: "medium",
      tag: "unit-other-tag",
      outFile: "/tmp/unit-other-findings.json",
    });
    expect(second.env.XDG_DATA_HOME).not.toBe(first.env.XDG_DATA_HOME);
    expect(first.env.XDG_DATA_HOME).toContain("unit-pwd");
    expect(second.env.XDG_DATA_HOME).toContain("unit-other-tag");
  });
});

describe("openCodeConfig", () => {
  beforeEach(() => resetOpenCodeConfig());
  afterEach(() => resetOpenCodeConfig());

  it("writes the settings once and hands every later caller the same directory", async () => {
    const first = await openCodeConfig("system", "guidance");
    const second = await openCodeConfig("system", "guidance");
    expect(second).toBe(first);
  });

  it("refuses a second, different prompt rather than silently serving the first", async () => {
    await openCodeConfig("system", "guidance");
    expect(() => openCodeConfig("different system", "guidance")).toThrow(/different prompt/);
  });

  it("keeps a named system prompt in its own directory beside the reviewer contract", async () => {
    const reviewer = await openCodeConfig("system", "", "none");
    const named = await openCodeConfig("intent system", "", "none", "intent");
    expect(named).not.toBe(reviewer);
    expect(path.basename(named)).toBe("no-tools-intent");
  });

  it("forgets the config when a run ends, so a server's next run can review another repository", async () => {
    const saved = { out: OUT, artifacts: ARTIFACTS };
    const tmp = mkdtempSync(path.join(os.tmpdir(), "diffloupe-config-reset-"));
    try {
      await openCodeConfig("system for repo one", "guidance");
      await expect(
        runReview({
          repo: path.join(tmp, "missing-clone"),
          target: { base: "a".repeat(40), head: "b".repeat(40), slug: "owner/repo-two" },
          tag: "unit-config-reset",
          config: { out: path.join(tmp, "out"), artifacts: path.join(tmp, "artifacts") },
        }),
      ).rejects.toThrow();
      await openCodeConfig("system for repo two", "guidance");
    } finally {
      applyConfig(saved);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gives the reviewer tool guidance, which replacing the built-in prompt removed", async () => {
    const settings = openCodeSettings("SYSTEM TEXT", "GUIDANCE TEXT");
    expect(settings.agents.reviewer.system).toContain("SYSTEM TEXT");
    expect(settings.agents.reviewer.system).toContain("GUIDANCE TEXT");
  });

  it("registers tilth outside Code Mode, so its tools are called by the names the guidance uses", async () => {
    const settings = openCodeSettings("system", "guidance");
    expect(settings.mcp.servers.tilth?.command).toContain("tilth");
    expect(settings.mcp.servers.tilth?.codemode).toBe(false);
  });

  it("gives a no-tools agent no MCP servers and no read tools", async () => {
    const settings = openCodeSettings("system", "", "none");
    expect(Object.keys(settings.mcp.servers)).toEqual([]);
    const allowed = settings.agents.reviewer.permissions.filter((p) => p.effect === "allow").map((p) => p.action);
    expect(allowed).not.toContain("read");
    expect(allowed).toContain("edit");
  });

  it("denies every tool it does not name, with the deny first so later allows win", async () => {
    const { permissions } = openCodeSettings("system", "guidance").agents.reviewer;
    expect(permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    const allowed = permissions.filter((p) => p.effect === "allow").map((p) => p.action);
    expect(allowed).toEqual(
      expect.arrayContaining(["read", "glob", "grep", "shell", "tilth_*", "edit", "external_directory"]),
    );
    for (const action of ["execute", "subagent", "question", "skill", "webfetch", "websearch"]) {
      expect(allowed).not.toContain(action);
    }
  });

  it("turns off automatic compaction, an unbudgeted call that rewrites the context mid-review", async () => {
    expect(openCodeSettings("system", "guidance").compaction).toEqual({ auto: false });
  });

  it("sets no temperature, which this model rejects", async () => {
    const settings = openCodeSettings("system", "guidance");
    expect(settings.agents.reviewer).not.toHaveProperty("temperature");
  });

  it("disables the formatter, which would rewrite the findings file after the agent wrote it", async () => {
    expect(openCodeSettings("system", "guidance").formatter).toBe(false);
  });
});

describe("groupByDir", () => {
  it("collapses a directory of many files to one line, so the guide's demanded output stops scaling with the file count", () => {
    const files = Array.from({ length: 54 }, (_, i) => `src/react/semantic/site-${i}-semantic.ts`);
    expect(groupByDir(files)).toBe("- src/react/semantic/ (54 files)");
  });

  it("names a lone file outright rather than describing a group of one", () => {
    expect(groupByDir(["src/a/only.ts"])).toBe("- src/a/only.ts");
  });

  it("puts the largest directories first, since those are the ones worth grouping", () => {
    const files = ["a/one.ts", "b/x.ts", "b/y.ts", "b/z.ts", "c/p.ts", "c/q.ts"];
    expect(groupByDir(files).split("\n")).toEqual([
      "- b/ (3 files)",
      "- c/ (2 files)",
      "- a/one.ts",
    ]);
  });

  it("keeps repo-root files addressable, which is where lockfiles and manifests live", () => {
    expect(groupByDir(["package.json", "pnpm-lock.yaml"]).split("\n")).toEqual([
      "- ./ (2 files)",
    ]);
  });

  it("returns nothing for no files, so an empty section stays empty", () => {
    expect(groupByDir([])).toBe("");
  });
});

describe("slice failure reporting", () => {
  const ndjson = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");
  const base = { outFile: "scratch/t-s00.json", stderr: "", exitCode: 0, cwd: "/tmp/subject" };

  it("spots a write to the wrong path", () => {
    const stdout = ndjson({
      type: "tool_use",
      part: { type: "tool", tool: "write", state: { status: "completed", input: { path: "scratch/other-s00.json" } } },
    });
    const f = diagnoseMissingOutput({ ...base, stdout });
    expect(f.kind).toBe("wrong-path");
    expect(f.message).toContain("scratch/other-s00.json");
  });

  it("does not count a write to the output file as the wrong path", () => {
    const stdout = ndjson({
      type: "tool_use",
      part: { type: "tool", tool: "write", state: { status: "completed", input: { path: "/tmp/subject/scratch/t-s00.json" } } },
    });
    expect(diagnoseMissingOutput({ ...base, stdout }).kind).toBe("no-output");
  });

  it("reports a provider error ahead of anything else", () => {
    const stdout = ndjson({ type: "error", error: { type: "provider.auth", message: "invalid x-api-key", status: 401 } });
    const f = diagnoseMissingOutput({ ...base, stdout, exitCode: 1 });
    expect(f.kind).toBe("provider");
    expect(f.message).toContain("invalid x-api-key");
  });

  it("reports a non-zero exit with the last stderr line", () => {
    const f = diagnoseMissingOutput({ ...base, stdout: "", exitCode: 2, stderr: "warming up\nboom" });
    expect(f).toEqual({ kind: "exit", message: "exited with code 2 without writing its output: boom" });
  });

  it("reports unparseable output", () => {
    expect(diagnoseMissingOutput({ ...base, stdout: "", parseError: "Unexpected token" }).kind).toBe("invalid-json");
  });

  it("lists each slice and skips the doctor hint when the agents ran normally", () => {
    const failed = [
      { tag: "t-s00", exitCode: 0, failure: { kind: "wrong-path", message: "wrote its output to a instead of b" } },
      { tag: "t-s01", exitCode: 0, failure: { kind: "no-output", message: "finished without writing its output file" } },
    ];
    const msg = describeSliceFailures(failed, "t", 2);
    expect(msg).toContain("s00: wrote its output to a instead of b");
    expect(msg).toContain("s01: finished without writing");
    expect(msg).not.toContain("doctor");
  });

  it("suggests doctor when a slice hit a provider error", () => {
    const failed = [{ tag: "t-s00", exitCode: 1, failure: { kind: "provider", message: "auth" } }];
    expect(describeSliceFailures(failed, "t", 1)).toContain("diffloupe doctor");
  });
});

describe("chooseReviewScope", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];

  it("narrows to the files that changed since the last review", () => {
    expect(chooseReviewScope(files, ["b.ts", "README.md"])).toEqual({ kind: "incremental", files: ["b.ts"] });
  });

  it("reviews nothing when no code file changed", () => {
    expect(chooseReviewScope(files, [])).toEqual({ kind: "incremental", files: [] });
  });

  it("falls back to a full review when most files changed", () => {
    const scope = chooseReviewScope(files, ["a.ts", "b.ts", "c.ts"]);
    expect(scope).toEqual({ kind: "full", files, reason: "3 of 5 files changed since the last review" });
  });

  it("keeps small changes incremental even when most of their files changed", () => {
    expect(chooseReviewScope(["a.ts", "b.ts"], ["a.ts", "b.ts"]).kind).toBe("incremental");
  });

  it("reviews in full when the previous head is not available", () => {
    expect(chooseReviewScope(files, null).kind).toBe("full");
  });
});
