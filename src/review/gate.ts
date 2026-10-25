/**
 * `diffloupe gate`: whether a pull request still has open findings at or above
 * a severity, read from the pull request as it stands now rather than from one
 * review round.
 *
 * A round's `result.json` counts only what that round posted. A repeated
 * finding is not posted again, so a blocker from round 1 that nobody fixed is
 * missing from round 2's count. The gate reads the bot's comments instead:
 *
 * - An inline finding is open until its thread is resolved on GitHub or the bot
 *   replies that it is fixed or withdrawn (`settledIds`). An outdated thread
 *   still counts; a moved anchor does not mean the problem went away.
 * - A finding written into the summary comment is open while the latest summary
 *   lists it. Each review rewrites the summary with what it still finds, and
 *   copies forward the earlier findings in files it did not read
 *   (`carriedClaims`).
 *
 * Findings in code the change did not touch (`pre=1` on the marker) are listed
 * but never fail the gate: the author was not asked to fix them.
 *
 * With `reviewMissing`, the caller says this push's review never reached the
 * pull request (the review or post job failed). The gate then fails when the
 * bot has never reviewed the pull request at all, so a broken first review does
 * not let a change merge unreviewed. A pull request with an earlier review is
 * judged on what that review left open.
 */
import type { FindingSeverity } from "../types/review-run.ts";
import type { GhComment, GhText, PullRequestThreads, ReviewThread } from "./core/context.ts";
import { readRulings } from "./core/context.ts";
import { findMarker, isOwnComment, readMarkers, settledIds, stripCopyBlock, stripMarkers } from "./core/lib/marker.ts";
import { SEV } from "./core/surface.ts";
import { SEVERITY_ORDER } from "./export.ts";

export const GATE_CONTEXT = "diffloupe/gate";

export type GateSeverity = FindingSeverity | "unknown";

export interface OpenFinding {
  fp: string | null;
  /** From the marker's `sev` field, else the badge in the text, else unknown. */
  severity: GateSeverity;
  file: string | null;
  line: string | null;
  title: string;
  url: string | null;
  /** `thread` for an inline comment, `summary` for a bullet in the summary comment. */
  where: "thread" | "summary";
  outdated?: true;
  /** The author disputed it and the review kept it: a person has to decide. */
  upheld?: true;
  /** In code the change did not touch. Listed, never counted against `failOn`. */
  preexisting?: true;
}

export interface GateOptions {
  failOn: FindingSeverity;
  /** A label on the pull request that passes the gate whatever is open. */
  overrideLabel?: string;
  /**
   * Treat a thread the pull request's author resolved as closed. By default
   * only someone else's resolution closes a thread, so the author cannot
   * clear a finding by resolving it.
   */
  countAuthorResolved?: boolean;
  /** This push's review did not reach the pull request. Fails when the bot never reviewed it. */
  reviewMissing?: boolean;
}

export interface GateResult {
  pr: number;
  url: string;
  head: string;
  failOn: FindingSeverity;
  open: OpenFinding[];
  /** The open findings at or above `failOn`. */
  matched: OpenFinding[];
  /** The override label, when the pull request has it. */
  override: string | null;
  /** The bot's summary comment, when there is one. */
  summaryUrl: string | null;
  /** `reviewMissing` was given and the bot has never reviewed the pull request. */
  unreviewed: boolean;
  fails: boolean;
}

function severityOf(sev: string | undefined, text: string): GateSeverity {
  if (sev && (SEVERITY_ORDER as readonly string[]).includes(sev)) return sev as FindingSeverity;
  // Comments written before markers carried `sev` still show the badge.
  const badge = (Object.entries(SEV) as [FindingSeverity, { badge: string }][]).find(([, s]) =>
    text.includes(s.badge),
  );
  return badge?.[0] ?? "unknown";
}

function threadFinding(
  t: ReviewThread,
  author: string,
  countAuthorResolved: boolean,
): OpenFinding | null {
  const root = t.comments[0];
  if (!root || !isOwnComment(root.body, root.authorType)) return null;
  const m = findMarker(root.body, "inline");
  if (!m) return null;
  if (t.resolved && (countAuthorResolved || t.resolvedBy !== author)) return null;
  const settled = settledIds(
    t.comments.map((c) => ({
      body: c.body,
      user: { type: c.authorType },
      ...(c.replyTo ? { in_reply_to_id: c.replyTo } : {}),
    })),
  );
  if (settled.has(root.id)) return null;
  const upheld = t.comments.some(
    (c) => isOwnComment(c.body, c.authorType, "reply") && findMarker(c.body, "reply")?.fields.dispute === "upheld",
  );
  const title =
    stripMarkers(root.body)
      .split("\n")
      .find((l) => l.trim())
      ?.replace(/^#+\s*/, "")
      .trim() ?? "";
  return {
    fp: m.fields.fp ?? null,
    severity: severityOf(m.fields.sev, root.body),
    file: m.fields.file ?? t.file ?? null,
    line: m.fields.line ?? (t.line ? String(t.line) : null),
    title,
    url: root.url || null,
    where: "thread",
    ...(t.outdated ? { outdated: true as const } : {}),
    ...(upheld ? { upheld: true as const } : {}),
    ...(m.fields.pre === "1" ? { preexisting: true as const } : {}),
  };
}

/** A summary bullet is `<badge> <title> — <location> · …`; this keeps the title. */
function summaryTitle(line: string): string {
  let text = stripMarkers(line).replace(/^\s*[-*]\s*/, "").trim();
  for (const { badge } of Object.values(SEV)) {
    if (text.startsWith(badge)) text = text.slice(badge.length).trim();
  }
  const cut = text.lastIndexOf(" — ");
  return cut > 0 ? text.slice(0, cut) : text;
}

/** The bot's latest summary comment. A second one only appears if a post raced another. */
export function latestSummary(comments: GhComment[]): GhComment | null {
  let latest: GhComment | null = null;
  for (const c of comments) {
    if (!isOwnComment(c.body ?? "", c.user?.type, "summary")) continue;
    if (!latest || c.id > latest.id) latest = c;
  }
  return latest;
}

export function openFindings(
  pr: Pick<PullRequestThreads, "author" | "threads">,
  summary: GhComment | null,
  opts: Pick<GateOptions, "countAuthorResolved"> = {},
): OpenFinding[] {
  const out: OpenFinding[] = [];
  const seen = new Set<string>();
  for (const t of pr.threads) {
    const f = threadFinding(t, pr.author, opts.countAuthorResolved === true);
    if (!f) continue;
    if (f.fp) {
      if (seen.has(f.fp)) continue;
      seen.add(f.fp);
    }
    out.push(f);
  }
  if (!summary?.body) return out;
  const body = stripCopyBlock(summary.body);
  const rulings = readRulings(body);
  const withdrawn = new Set(rulings.filter((r) => r.outcome === "withdrawn").map((r) => r.fp));
  const upheld = new Set(rulings.filter((r) => r.outcome === "upheld").map((r) => r.fp));
  for (const line of body.split("\n")) {
    for (const m of readMarkers(line)) {
      const fp = m.fields.fp;
      if (m.kind !== "summary-item" || !fp || seen.has(fp) || withdrawn.has(fp)) continue;
      seen.add(fp);
      out.push({
        fp,
        severity: severityOf(m.fields.sev, line),
        file: m.fields.file ?? null,
        line: m.fields.line ?? null,
        title: summaryTitle(line),
        url: summary.html_url ?? null,
        where: "summary",
        ...(upheld.has(fp) ? { upheld: true as const } : {}),
        ...(m.fields.pre === "1" ? { preexisting: true as const } : {}),
      });
    }
  }
  return out;
}

/**
 * The open findings at or above `threshold`. Unknown severity never matches:
 * the gate reports those findings rather than guessing how serious they are.
 * Neither do pre-existing findings.
 */
export function failsOpenGate(open: OpenFinding[], threshold: FindingSeverity): OpenFinding[] {
  const limit = SEVERITY_ORDER.indexOf(threshold);
  return open.filter(
    (f) => !f.preexisting && f.severity !== "unknown" && SEVERITY_ORDER.indexOf(f.severity) <= limit,
  );
}

export function evaluateGate(
  pr: PullRequestThreads,
  issueComments: GhComment[],
  opts: GateOptions,
): GateResult {
  const summary = latestSummary(issueComments);
  const open = openFindings(pr, summary, opts);
  const matched = failsOpenGate(open, opts.failOn);
  const override = opts.overrideLabel && pr.labels.includes(opts.overrideLabel) ? opts.overrideLabel : null;
  const unreviewed = opts.reviewMissing === true && !summary;
  return {
    pr: pr.number,
    url: pr.url,
    head: pr.headSha,
    failOn: opts.failOn,
    open,
    matched,
    override,
    summaryUrl: summary?.html_url ?? null,
    unreviewed,
    fails: (matched.length > 0 || unreviewed) && !override,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The commit status description. GitHub cuts it at 140 characters. */
export function gateDescription(r: GateResult): string {
  const at = `at ${r.failOn} or above`;
  const text = r.unreviewed
    ? r.override
      ? `Not reviewed: the review failed, passed by the ${r.override} label`
      : "Not reviewed: the review failed and no earlier review reached this PR"
    : !r.matched.length
    ? `No open findings ${at}`
    : r.override
      ? `${plural(r.matched.length, "open finding")} ${at}, passed by the ${r.override} label`
      : `${plural(r.matched.length, "open finding")} ${at}`;
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

export function formatGate(r: GateResult): string[] {
  const lines = [`PR #${r.pr}: ${gateDescription(r)}`];
  const row = (f: OpenFinding) => {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(no file)";
    const notes = [
      f.where === "summary" ? "in the summary" : "",
      f.outdated ? "outdated" : "",
      f.upheld ? "upheld after a dispute, needs a person" : "",
      f.preexisting ? "pre-existing, not counted" : "",
    ].filter(Boolean);
    return `  ${f.severity.padEnd(12)} ${where}  ${f.title}${notes.length ? ` (${notes.join(", ")})` : ""}${f.url ? `\n${" ".repeat(15)}${f.url}` : ""}`;
  };
  const others = r.open.filter((f) => !r.matched.includes(f));
  if (r.matched.length) lines.push("", `Open at ${r.failOn} or above:`, ...r.matched.map(row));
  if (others.length) lines.push("", "Other open findings:", ...others.map(row));
  const unknown = r.open.filter((f) => f.severity === "unknown").length;
  if (unknown) lines.push("", `${plural(unknown, "finding")} with no readable severity; not counted against --fail-on.`);
  return lines;
}

export interface GateDeps {
  readThreads: (slug: string, pr: number) => Promise<PullRequestThreads>;
  readComments: (slug: string, pr: number) => Promise<GhComment[]>;
  gh: GhText;
}

/**
 * Evaluate the gate and, with `status`, write the result as the
 * `diffloupe/gate` commit status so branch protection can require it. The
 * status goes on `status.sha`, or on the pull request's head.
 */
export async function runGate(
  slug: string,
  pr: number,
  opts: GateOptions & { status?: { sha?: string } },
  deps: GateDeps,
): Promise<GateResult> {
  const [threads, comments] = await Promise.all([deps.readThreads(slug, pr), deps.readComments(slug, pr)]);
  const result = evaluateGate(threads, comments, opts);
  if (opts.status) {
    await deps.gh([
      "api",
      "--method",
      "POST",
      `repos/${slug}/statuses/${opts.status.sha ?? result.head}`,
      "-f",
      `state=${result.fails ? "failure" : "success"}`,
      "-f",
      `context=${GATE_CONTEXT}`,
      "-f",
      `description=${gateDescription(result)}`,
      "-f",
      `target_url=${result.summaryUrl ?? result.url}`,
    ]);
  }
  return result;
}
