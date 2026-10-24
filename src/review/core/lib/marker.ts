/**
 * Hidden markers that let a re-review recognize its own output.
 *
 * Every body the bot writes carries one. Two consumers need it:
 *   - post.ts finds the previous summary comment and PATCHes it, instead of
 *     leaving one comment per push the way the old bot did.
 *   - the prior-comment gather tells the bot's own comments from a human's, so
 *     the model corroborates humans and does not corroborate itself.
 *
 * The kind is part of the marker because a pull request carries three distinct
 * comment species and only the summary is editable-in-place. Matching a bare
 * marker would find an inline comment and PATCH the wrong thing.
 */

import { createHash } from "node:crypto";

/**
 * `summary-item` marks one finding written into the body of the summary comment
 * because it could not be anchored to a changed line. It is not a comment of its
 * own — several appear inside one `summary` comment — so it exists purely to
 * give those findings the identity every inline finding gets from its own
 * marker.
 *
 * `dispute` records the ruling on a disputed finding inside the summary comment:
 * its fingerprint and whether the review withdrew or upheld it. The summary is
 * the only state that survives between runs, so this is what stops a dispute
 * being judged twice.
 *
 * `stopped` marks the notice put at the top of the summary comment when a push
 * was not reviewed because of `--max-rounds`. The next stopped push replaces it
 * instead of stacking a second one.
 */
export type MarkerKind = "summary" | "summary-item" | "inline" | "reply" | "dispute" | "stopped";

const PREFIX = "ai-review";

/**
 * A stable identity for one finding, carried in its marker.
 *
 * Keyed on the claim, not the location. Line numbers move between pushes for
 * reasons that have nothing to do with the finding — an import added above it is
 * enough — so a location-keyed hash would report the same problem again as soon
 * as anything shifted. File plus title survives that.
 *
 * The title is normalized because the model rewrites it slightly on each run:
 * same claim, different capitalization, an added article, a different backtick.
 */
export function fingerprint(file: string, title: string): string {
  const claim = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return createHash("sha1").update(`${file}\0${claim}`).digest("hex").slice(0, 10);
}

/**
 * Values go inside an HTML comment, which ends at the first `-->`. Collapsing
 * repeated dashes and dropping `>` makes that sequence unformable, without
 * mangling the hyphens that appear in most file paths.
 */
function sanitize(value: string | number): string {
  return String(value)
    .replace(/\s+/g, "_")
    .replace(/-{2,}/g, "-")
    .replace(/>/g, "_");
}

export function marker(kind: MarkerKind, fields: Record<string, string | number> = {}): string {
  const parts = [`kind=${kind}`];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${sanitize(value)}`);
  }
  return `<!-- ${PREFIX} ${parts.join(" ")} -->`;
}

const MARKER_RE = new RegExp(`<!--\\s*${PREFIX}\\s+([^>]*?)\\s*-->`, "g");

/** Removes every marker, with the space before it, and the blank lines a removed marker line leaves behind. */
export function stripMarkers(text: string): string {
  return text
    .replace(new RegExp(`[ \\t]*${MARKER_RE.source}`, "g"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * Bracket the summary comment's "Copy all findings" section. It repeats every
 * finding's full text, so the next run cuts it out before showing the summary
 * to the model. Not `ai-review` markers: `readMarkers` and `stripMarkers` skip them.
 */
export const COPY_BLOCK_START = "<!-- ai-review-copy -->";
export const COPY_BLOCK_END = "<!-- /ai-review-copy -->";

/** Removes the copy section and the blank lines it leaves behind. */
export function stripCopyBlock(body: string): string {
  const start = body.indexOf(COPY_BLOCK_START);
  const end = body.lastIndexOf(COPY_BLOCK_END);
  if (start < 0 || end < start) return body;
  return `${body.slice(0, start).trimEnd()}\n\n${body.slice(end + COPY_BLOCK_END.length).trimStart()}`.trim();
}

const KINDS: readonly string[] = ["summary", "summary-item", "inline", "reply", "dispute", "stopped"];

export interface ParsedMarker {
  kind: MarkerKind;
  fields: Record<string, string>;
}

function parse(inner: string): ParsedMarker | null {
  const fields: Record<string, string> = {};
  for (const pair of inner.split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const kind = fields.kind;
  if (!KINDS.includes(kind)) return null;
  delete fields.kind;
  return { kind: kind as MarkerKind, fields };
}

/** Every marker in a body, in order. A summary comment carries several. */
export function readMarkers(body: string): ParsedMarker[] {
  const out: ParsedMarker[] = [];
  for (const m of body.matchAll(MARKER_RE)) {
    const parsed = parse(m[1]);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * The first marker of a given kind.
 *
 * A summary comment holds one `summary-item` per finding that could not be
 * anchored, and its own `summary` marker last. Anything asking "is this the
 * summary comment" has to look for that kind rather than at whichever marker
 * comes first, or a summary carrying findings stops being recognizable and the
 * next push posts a second one.
 */
export function findMarker(body: string, kind: MarkerKind): ParsedMarker | null {
  return readMarkers(body).find((m) => m.kind === kind) ?? null;
}

/** The first marker in a body, for the single-marker kinds. */
export function readMarker(body: string): ParsedMarker | null {
  return readMarkers(body)[0] ?? null;
}

/**
 * Whether a comment is one the bot wrote.
 *
 * Both signals are required. The marker alone is not proof: a human quoting the
 * bot's comment copies the marker verbatim, and treating that as our own output
 * would suppress a real finding. The author alone is not enough either, since
 * every other Actions workflow posts under the same `github-actions[bot]`.
 *
 * `authorType` is the GitHub user object's `type` field. Pass null when the
 * caller genuinely has no author information, which accepts the marker alone.
 */
export function isOwnComment(
  body: string,
  authorType: string | null | undefined,
  kind?: MarkerKind,
): boolean {
  if (authorType != null && authorType !== "Bot") return false;
  // Looked up by kind rather than positionally: the summary comment carries a
  // marker per unanchored finding before its own.
  if (kind !== undefined) return findMarker(body, kind) !== null;
  return readMarkers(body).length > 0;
}

/**
 * Which review comments the bot has already declared fixed.
 *
 * Read from the marker's `of` field, not from `in_reply_to_id`. Those are the
 * same number only when the comment closed out is the first in its thread:
 * GitHub reports `in_reply_to_id` as the thread's root, so a close-out sent
 * against a later comment comes back filed under the first one. A caller that
 * looks up the id it actually closed out then misses. The marker is written by
 * this pipeline and names the comment it meant; `in_reply_to_id` is the
 * fallback for a reply posted before the marker carried `of`.
 *
 * This lives here because both halves of the run need the same answer and they
 * need it for opposite reasons. The pipeline uses it to mark a prior comment
 * `addressed`, which drops its fingerprint from the already-said set so a
 * reverted fix can be reported again. The posting step uses it to avoid sending
 * a second "✅ Fixed" reply into a thread that already has one. Two copies of
 * the rule drift, and when they drift the stricter one silently wins.
 */
export function settledIds(
  comments: { in_reply_to_id?: number; body?: string; user?: { type?: string } }[],
): Set<number> {
  const settled = new Set<number>();
  for (const c of comments) {
    const body = c.body ?? "";
    if (!c.in_reply_to_id || !isOwnComment(body, c.user?.type, "reply")) continue;
    const m = readMarker(body);
    if (m?.fields.addressed !== "1") continue;
    const of = Number(m.fields.of);
    settled.add(Number.isFinite(of) && of > 0 ? of : c.in_reply_to_id);
  }
  return settled;
}

/**
 * An answer to one of the bot's findings, written by the author or by an agent
 * working for them:
 *
 *   <!-- ai-review-response fp=<fingerprint> verdict=disputed -->
 *
 * `verdict` is `disputed` (the finding is wrong) or `fixed` (the code now
 * addresses it). `action` is accepted in place of `verdict`. The text around
 * the marker is the reason.
 *
 * A different prefix from the bot's own markers on purpose: `readMarkers` and
 * `isOwnComment` never mistake a response for the bot's output, whoever posts it.
 */
export interface ReviewResponse {
  fp: string;
  verdict: "disputed" | "fixed";
}

const RESPONSE_RE = new RegExp(`<!--\\s*${PREFIX}-response\\s+([^>]*?)\\s*-->`, "g");

/**
 * Every well-formed response marker in a body, in order, each with the reason
 * it gives. One comment may answer several findings. With one marker the
 * reason is the whole comment. With several, each marker owns the text after
 * it up to the next one — or the text before it, when the markers close their
 * paragraphs instead of opening them.
 */
export function readResponses(body: string): (ReviewResponse & { reason: string })[] {
  const matches = [...body.matchAll(RESPONSE_RE)];
  const clean = (s: string) => stripMarkers(s).trim();
  const between = matches.map((m, i) =>
    body.slice((m.index ?? 0) + m[0].length, matches[i + 1]?.index ?? body.length),
  );
  const before = body.slice(0, matches[0]?.index ?? 0);
  const trailing = !!clean(before) && !clean(between.at(-1) ?? "");
  const out: (ReviewResponse & { reason: string })[] = [];
  matches.forEach((m, i) => {
    const fields: Record<string, string> = {};
    for (const pair of (m[1] ?? "").split(/\s+/)) {
      const eq = pair.indexOf("=");
      if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const verdict = fields.verdict ?? fields.action;
    const fp = fields.fp;
    if (!fp || !/^[0-9a-f]{6,40}$/i.test(fp) || (verdict !== "disputed" && verdict !== "fixed")) return;
    const reason = matches.length === 1
      ? clean(body.replace(RESPONSE_RE, ""))
      : trailing
        ? clean(i === 0 ? before : (between[i - 1] ?? ""))
        : clean((i === 0 ? before : "") + (between[i] ?? ""));
    out.push({ fp: fp.toLowerCase(), verdict, reason });
  });
  return out;
}
