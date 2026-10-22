/**
 * Sends the GitHub API calls in a CI run's `payloads.json`.
 *
 * This runs as its own job, separate from the review, for a security reason.
 * The review feeds the pull request title, body and diff to a model, and all of
 * that is text the author controls. A step that builds prompts from that text
 * must not also hold a token that can write to the repository. So the review
 * job runs read-only and writes a payload file, and this step holds the write
 * token and runs no model. It composes no prose of its own.
 *
 *   bun src/review/post.ts <payloads.json>
 *
 *   PR            pull request number to post to (required)
 *   HEAD          the reviewed commit sha (required)
 *   ARTIFACT_URL  replaces the run-page link in the summary's detail line
 *   DRY_RUN       "0" sends. Anything else, including unset, only prints.
 *   GH_TOKEN      passed through to gh
 *
 * The target comes from the environment, never from the payload file: the file
 * is written in a job where a model reads author-controlled text, so it gets to
 * supply comment bodies and nothing else.
 *
 * The summary comment is updated in place across pushes. Inline comments are
 * not: a review is immutable once submitted, and a finding that survives a push
 * is reconciled by the next review rather than by editing.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isOwnComment, readMarker, settledIds } from "./core/lib/marker.ts";
import { run, text } from "./core/lib/proc.ts";
import { repoSlug } from "./core/lib/target.ts";

interface ApiCall {
  method: string;
  endpoint: string;
  body: Record<string, unknown>;
}

interface ReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: string;
  body: string;
}

export interface Payloads {
  summary: ApiCall;
  review: ApiCall;
  replies: ApiCall[];
}

export interface ApiResult {
  ok: boolean;
  status: number;
  data: unknown;
  stderr: string;
}

export interface PostTarget {
  slug: string;
  pr: string;
  head: string;
  artifactUrl?: string | undefined;
}

export interface PostDeps {
  /** Sends one write. Not called on a dry run. */
  send: (method: string, endpoint: string, body?: unknown) => Promise<ApiResult>;
  /** Reads every page of a list endpoint. Called on a dry run too. */
  list: (endpoint: string) => Promise<unknown[]>;
  log: (line: string) => void;
}

interface IssueComment {
  id: number;
  body?: string;
  user?: { type?: string };
  html_url?: string;
}

interface ReviewCommentRecord {
  id?: number;
  in_reply_to_id?: number;
  body?: string;
  user?: { type?: string };
}

/** The three kinds of call this step may make, built from the target rather than read. */
export interface Targets {
  summary: string;
  review: string;
  replies: { endpoint: string; body: Record<string, unknown> }[];
}

/**
 * Rebuilds every endpoint from the slug and pull request number, and refuses
 * to send anything if the payload file disagrees. `gh api` accepts an absolute
 * URL, so an endpoint read from the file could send the token anywhere.
 */
export function checkedEndpoints(payloads: Payloads, slug: string, pr: string): Targets {
  const summary = `repos/${slug}/issues/${pr}/comments`;
  const review = `repos/${slug}/pulls/${pr}/reviews`;
  const expect = (actual: string, wanted: string) => {
    if (actual !== wanted) {
      throw new Error(`payload names endpoint "${actual}", expected "${wanted}" — refusing to send`);
    }
  };
  expect(payloads.summary.endpoint, summary);
  expect(payloads.review.endpoint, review);

  const escaped = slug.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const replyPattern = new RegExp(`^repos/${escaped}/pulls/${pr}/comments/(\\d+)/replies$`);
  const replies = payloads.replies.map((r) => {
    const m = replyPattern.exec(r.endpoint);
    if (!m) throw new Error(`payload reply endpoint "${r.endpoint}" does not target PR #${pr} — refusing to send`);
    return { endpoint: `repos/${slug}/pulls/${pr}/comments/${m[1]}/replies`, body: r.body };
  });
  return { summary, review, replies };
}

/** GitHub's comment size limit, the same value as `COMMENT_LIMIT` in core/render.ts. */
const COMMENT_LIMIT = 65536;

/**
 * Points the summary's detail link at the uploaded artifact instead of the run
 * page. The review sized the body to GitHub's limit with the shorter run URL
 * in it, so the link stays as it is when the swap would go over.
 */
export function linkDetailArtifact(body: string, artifactUrl?: string): string {
  const url = artifactUrl?.trim();
  if (!url) return body;
  const linked = body.replace(/(\[Full review detail\]\()[^)]*(\))/, `$1${url}$2`);
  return linked.length <= COMMENT_LIMIT ? linked : body;
}

/**
 * Drops calls whose body carries a fingerprint already on the pull request.
 * The review checks this too, but this step is the one with a live token, so
 * it is the place a repeat is reliably caught.
 */
export function dropRepeats<T extends { body: string }>(
  calls: T[],
  posted: Set<string>,
  onDrop: (call: T) => void = () => {},
): T[] {
  if (posted.size === 0) return calls;
  return calls.filter((call) => {
    const fp = readMarker(call.body)?.fields.fp;
    if (!fp || !posted.has(fp)) return true;
    onDrop(call);
    return false;
  });
}

/** Fingerprints the bot has already posted, minus those it has since closed out as fixed. */
export function postedState(comments: ReviewCommentRecord[]): { claims: Set<string>; settled: Set<number> } {
  const settled = settledIds(comments);
  const claims = new Set<string>();
  for (const c of comments) {
    const body = c.body ?? "";
    if (!isOwnComment(body, c.user?.type)) continue;
    if (c.id !== undefined && settled.has(c.id)) continue;
    const fp = readMarker(body)?.fields.fp;
    if (fp) claims.add(fp);
  }
  return { claims, settled };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(method: string, endpoint: string, body: unknown): string {
  const size = body === undefined ? 0 : JSON.stringify(body).length;
  return `${method} ${endpoint}${size ? ` (${size} bytes)` : ""}`;
}

/**
 * Sends the summary, the inline review and the replies. Returns the number of
 * calls that failed; each group is attempted even when an earlier one fails.
 */
export async function postPayloads(
  payloads: Payloads,
  target: PostTarget,
  opts: { dryRun: boolean; deps: PostDeps },
): Promise<number> {
  const { dryRun, deps } = opts;
  const { slug, pr, head } = target;
  const log = deps.log;
  const targets = checkedEndpoints(payloads, slug, pr);
  let failures = 0;

  const send = async (method: string, endpoint: string, body?: unknown, recoverable = false) => {
    if (dryRun) {
      log(`  [dry-run] ${describe(method, endpoint, body)}`);
      return null;
    }
    const result = await deps.send(method, endpoint, body);
    const id = (result.data as { id?: number } | null)?.id;
    log(`  ${result.ok ? "ok" : `FAILED ${result.status}`} ${describe(method, endpoint, body)}${id ? ` -> id ${id}` : ""}`);
    if (!result.ok) {
      if (!recoverable) failures++;
      log(`    ${result.stderr.split("\n")[0]}`);
    }
    return result;
  };

  const attempt = async (what: string, body: () => Promise<void>) => {
    try {
      await body();
    } catch (error) {
      failures++;
      log(`${what}: FAILED — ${message(error)}`);
    }
  };

  log(`${dryRun ? "DRY RUN — nothing is sent" : "SENDING TO GITHUB"}: ${slug} PR #${pr}\n`);

  let posted: { claims: Set<string>; settled: Set<number> } = { claims: new Set(), settled: new Set() };
  try {
    posted = postedState((await deps.list(`repos/${slug}/pulls/${pr}/comments`)) as ReviewCommentRecord[]);
    if (posted.claims.size > 0) log(`${posted.claims.size} claim(s) already on this PR\n`);
  } catch (error) {
    failures++;
    log(`WARNING cannot list review comments, repeats will not be caught: ${message(error)}\n`);
  }

  await attempt("summary comment", async () => {
    log("summary comment:");
    const raw = payloads.summary.body.body;
    if (typeof raw !== "string") throw new Error("payload summary has no body");
    const body = { body: linkDetailArtifact(raw, target.artifactUrl) };
    // Creating a comment without finding the existing one would leave two
    // summaries on the pull request, so a failed lookup skips the summary.
    const comments = (await deps.list(`repos/${slug}/issues/${pr}/comments`)) as IssueComment[];
    const mine = comments.filter((c) => isOwnComment(c.body ?? "", c.user?.type, "summary"));
    const existing = mine.at(-1);
    if (existing) {
      log(`  updating comment ${existing.id} in place${existing.html_url ? ` — ${existing.html_url}` : ""}`);
      await send("PATCH", `repos/${slug}/issues/comments/${existing.id}`, body);
    } else {
      log("  no existing summary comment, creating one");
      await send("POST", targets.summary, body);
    }
  });

  await attempt("inline review", async () => {
    const all = (payloads.review.body.comments ?? []) as ReviewComment[];
    log(`inline review (${all.length} comment${all.length === 1 ? "" : "s"}):`);
    const comments = dropRepeats(all, posted.claims, (c) => log(`  skipping ${c.path}:${c.line} — already posted`));
    // An empty review would still post a review event onto the pull request.
    if (comments.length === 0) return log("  nothing to send");
    // Built field by field: the file does not get to choose `event`, so it
    // cannot turn this into an approval.
    const result = await send("POST", targets.review, { commit_id: head, event: "COMMENT", comments }, true);
    if (result === null || result.ok) return;
    if (result.status !== 422) {
      failures++;
      return;
    }
    // GitHub rejects the whole review over one comment on a line outside the
    // diff. One call per comment loses only that comment.
    log("  review rejected as a batch, retrying one comment at a time");
    for (const c of comments) {
      await send("POST", `repos/${slug}/pulls/${pr}/comments`, {
        commit_id: head,
        path: c.path,
        line: c.line,
        ...(c.start_line ? { start_line: c.start_line } : {}),
        side: c.side,
        body: c.body,
      });
    }
  });

  await attempt("replies", async () => {
    log(`replies (${targets.replies.length}):`);
    const candidates = targets.replies
      .map((r) => ({ call: r, body: String(r.body.body ?? "") }))
      .filter((r) => {
        const m = readMarker(r.body);
        if (m?.fields.addressed !== "1" || !posted.settled.has(Number(m.fields.of))) return true;
        log(`  skipping ${r.call.endpoint} — already closed out`);
        return false;
      });
    const replies = dropRepeats(candidates, posted.claims, (r) => log(`  skipping ${r.call.endpoint} — already posted`));
    if (replies.length === 0) log("  nothing to send");
    for (const r of replies) await send("POST", r.call.endpoint, r.call.body);
  });

  return failures;
}

let bodyFiles = 0;

/** The body goes to gh in a file: a summary comment can run to tens of kilobytes. */
async function ghSend(method: string, endpoint: string, body?: unknown): Promise<ApiResult> {
  const args = ["api", endpoint, "--method", method];
  let file: string | undefined;
  if (body !== undefined) {
    file = path.join(os.tmpdir(), `diffloupe-post-${process.pid}-${bodyFiles++}.json`);
    await writeFile(file, JSON.stringify(body));
    args.push("--input", file);
  }
  try {
    const result = await run("gh", args, { allowFail: true });
    // gh reports the HTTP status only in its error text, e.g. "(HTTP 422)".
    const status = result.code === 0 ? 200 : Number(/HTTP (\d{3})/.exec(result.stderr)?.[1] ?? 0);
    let data: unknown = null;
    try {
      data = JSON.parse(result.stdout);
    } catch {
      /* empty or non-JSON response */
    }
    return { ok: result.code === 0, status, data, stderr: result.stderr.trim() };
  } finally {
    if (file) await rm(file, { force: true });
  }
}

async function ghList(endpoint: string): Promise<unknown[]> {
  // --slurp wraps each page in an outer array, so pages concatenate cleanly.
  const pages = JSON.parse(await text("gh", ["api", "--paginate", "--slurp", endpoint])) as unknown[][];
  return pages.flat();
}

async function main(): Promise<number> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: bun src/review/post.ts <payloads.json>");
  const pr = process.env.PR ?? "";
  const head = process.env.HEAD ?? "";
  if (!/^\d+$/.test(pr)) throw new Error("set PR to the pull request number to post to");
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("set HEAD to the reviewed commit's full sha");
  const slug = process.env.GITHUB_REPOSITORY ?? (await repoSlug(process.cwd()));
  const payloads = JSON.parse(await readFile(file, "utf8")) as Payloads;
  // Sending is opt-in: an unset or mistyped variable has to land on "print only".
  const dryRun = process.env.DRY_RUN !== "0";
  const failures = await postPayloads(
    payloads,
    { slug, pr, head, artifactUrl: process.env.ARTIFACT_URL },
    { dryRun, deps: { send: ghSend, list: ghList, log: (line) => console.log(line) } },
  );
  if (dryRun) console.log("\nDRY RUN — nothing was sent. Set DRY_RUN=0 to post.");
  else if (failures > 0) console.log(`\n${failures} call${failures === 1 ? "" : "s"} failed`);
  else console.log("\nall calls succeeded");
  return failures > 0 ? 1 : 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(message(error));
      process.exit(1);
    },
  );
}
