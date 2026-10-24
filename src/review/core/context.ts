import { text } from "./lib/proc.ts";
import { readJson } from "./lib/io.ts";
import {
  findMarker,
  isOwnComment,
  readMarkers,
  readResponses,
  settledIds,
  stripCopyBlock,
  stripMarkers,
  type ReviewResponse,
} from "./lib/marker.ts";
import { SUBJECT } from "./config.ts";
import type { StatedIntent } from "./prompts.ts";

// ---------------------------------------------------------------- context

export async function gitText(args: string[]): Promise<string> {
  return await text("git", ["-C", SUBJECT, "-c", "diff.renames=true", ...args]);
}

export type GhText = (args: string[]) => Promise<string>;

const ghText: GhText = (args) => text("gh", args);

export interface GatherOptions {
  /**
   * Throw when `gh` fails instead of carrying on without the pull request's
   * description or comments. Posting without them repeats earlier comments.
   */
  strict?: boolean;
  gh?: GhText;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Every hunk header in the diff, with no hunk bodies. Git puts the enclosing
 * function or class after the `@@`, so this says where each change lands without
 * carrying the change itself — a few hundred lines where the full diff of a large
 * PR is hundreds of kilobytes. Enough to group files; not enough to review them.
 */
export async function diffOutline(base: string, head: string, files: string[]): Promise<string> {
  const raw = await gitText(["diff", "--unified=0", `${base}..${head}`, "--", ...files]);
  return raw
    .split("\n")
    .filter((l) => l.startsWith("diff --git ") || l.startsWith("@@"))
    .join("\n");
}

/**
 * PR description plus commit subjects: the author's stated intent. `stated` is
 * what the person asking for the review said, kept apart from the description
 * so the prompts can say who wrote which.
 */
export async function gatherIntent(
  slug: string,
  pr: string | undefined,
  base: string,
  head: string,
  stated?: string,
  opts: GatherOptions = {},
): Promise<StatedIntent> {
  const gh = opts.gh ?? ghText;
  let title = "";
  let body = "";
  // A bare commit range has no description, so the commit subjects are the only
  // statement of intent there is.
  if (pr) {
    try {
      const meta = JSON.parse(await gh(["api", `repos/${slug}/pulls/${pr}`])) as {
        title?: string;
        body?: string;
      };
      title = meta.title ?? "";
      body = meta.body ?? "";
    } catch (err) {
      if (opts.strict) throw new Error(`reading the pull request description: ${errorText(err)}`, { cause: err });
      /* offline / no access: intent section degrades to commits only */
    }
  }
  const log = await gitText(["log", "--format=%s%n%b%n---", `${base}..${head}`]);
  return { title, body, commits: log.trim(), ...(stated?.trim() ? { stated: stated.trim() } : {}) };
}

export interface PriorComment {
  id: number;
  file?: string | undefined;
  line?: number | undefined;
  author: string;
  body: string;
  resolved: boolean;
  commit?: string | undefined;
  url?: string | undefined;
  /**
   * When GitHub says the comment was created. Review comments and issue
   * comments number their ids separately, so this is what orders the two.
   */
  createdAt?: string;
  /** Written by this bot on an earlier push, rather than by a reviewer. */
  mine?: boolean;
  /** On the bot's own comments: the identity of the finding it reported. */
  fingerprint?: string | undefined;
  /**
   * The bot has already replied to this one saying the code now fixes it. Such
   * a comment is settled: it is left out of the prompt entirely.
   */
  addressed?: boolean;
  /**
   * Set when this comment is a reply inside someone else's thread rather than
   * the comment that started one. A reply is never an independent prior
   * finding: a close-out says a point is finished and a corroboration restates
   * a finding that is already listed under its own comment.
   */
  inReplyTo?: number;
  /**
   * On the bot's own summary comment: how many reviews it has posted here. The
   * count lives in the comment because the comment is the only state that
   * survives between runs — the workspace does not.
   */
  runs?: number;
  /** On the bot's own summary comment: the head commit the last review saw. */
  head?: string;
  /**
   * On the bot's own summary comment: the findings reported inside its body
   * rather than as comments of their own, because they sit outside the diff.
   */
  summaryClaims?: { fp: string; file: string; line: string; text?: string }[];
  /**
   * GitHub's account of the author's standing in this repository: `OWNER`,
   * `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE` and so on.
   */
  association?: string;
  /**
   * Answers to the bot's findings, from response markers in this comment: see
   * `readResponses`. Read from anyone, bots included, since the author's own
   * agent is the expected sender.
   */
  responses?: (ReviewResponse & { reason: string })[];
  /**
   * On the bot's own summary comment: every dispute it has already ruled on,
   * read from the `dispute` markers it carries forward on each review.
   */
  rulings?: PriorRuling[];
}

export type DisputeOutcome = "withdrawn" | "upheld";

export interface PriorRuling {
  fp: string;
  outcome: DisputeOutcome;
  /** The summary bullet the ruling was written as, without its marker. */
  label: string;
}

/** The `dispute` markers in the bot's summary, each with the bullet text it sits on. */
export function readRulings(body: string): PriorRuling[] {
  const out: PriorRuling[] = [];
  for (const line of body.split("\n")) {
    for (const m of readMarkers(line)) {
      const { fp, outcome } = m.fields;
      if (m.kind !== "dispute" || !fp || (outcome !== "withdrawn" && outcome !== "upheld")) continue;
      out.push({ fp, outcome, label: stripMarkers(line).replace(/^\s*[-*]\s*/, "").trim() });
    }
  }
  return out;
}

function responsesOf(body: string): Pick<PriorComment, "responses"> {
  const responses = readResponses(body);
  return responses.length ? { responses } : {};
}

export interface GhComment {
  id: number;
  path?: string;
  line?: number;
  original_line?: number;
  user?: { login?: string; type?: string };
  body?: string;
  original_commit_id?: string;
  html_url?: string;
  in_reply_to_id?: number;
  author_association?: string;
  created_at?: string;
}

export async function ghComments(endpoint: string, gh: GhText = ghText): Promise<GhComment[]> {
  return JSON.parse(await gh(["api", "--paginate", endpoint])) as GhComment[];
}

/** The raw body of the bot's newest summary comment on the pull request, markers included. */
export async function latestOwnSummary(slug: string, pr: string, opts: { gh?: GhText } = {}): Promise<string | null> {
  const mine = (await ghComments(`repos/${slug}/issues/${pr}/comments`, opts.gh)).filter((c) =>
    isOwnComment(c.body ?? "", c.user?.type, "summary"),
  );
  const latest = mine.reduce<GhComment | undefined>((a, c) => (a && a.id > c.id ? a : c), undefined);
  return latest?.body ?? null;
}

/**
 * The bot's own summary comment restated for the prompt.
 *
 * Only the markers come out. They are machine identity, read straight from the
 * raw body before this runs, and several hundred bytes of hex the model has no
 * use for.
 *
 * `<details>` blocks stay. They used to be stripped, when the summary carried
 * the whole walkthrough and the full argument for every finding and ran to
 * twelve kilobytes. Those now live in the detail file, and what is left behind a
 * `<details>` is all conclusion: the findings routed off the inline set, the
 * comments agreed with, and the list of things considered and dropped. Stripping
 * them leaves the next run unable to see what it demoted or what it already
 * rejected, which is the context that stops it re-litigating both.
 *
 * The "Copy all findings" section is the exception: it repeats every finding's
 * full argument, which is what the detail file was split out to hold.
 */
export function condenseOwnSummary(body: string): string {
  return stripCopyBlock(body)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Comments already on the PR, both the reviewers' and the bot's own.
 *
 * Reading its own output back is the single largest correctness fix over the
 * old bot. That one never fetched anything, so every push re-reported the same
 * findings labelled as first reports, and roughly half its total output volume
 * was restatement. The two sources serve opposite purposes and are tagged
 * accordingly: a human's comment is something to corroborate and reply into, a
 * previous one of its own is something not to say again.
 *
 * Both endpoints are needed. Inline comments carry the findings, and the issue
 * comment carries the summary — including findings that could not be anchored
 * to a diff line and therefore exist nowhere else.
 */
export async function gatherPriorComments(
  slug: string,
  pr: string | undefined,
  opts: GatherOptions = {},
): Promise<PriorComment[]> {
  const fixture = process.env.PRIOR_FIXTURE;
  if (fixture) return await readJson<PriorComment[]>(fixture);
  // A bare commit range has no comment threads to reconcile against.
  if (!pr) return [];
  const gh = opts.gh ?? ghText;
  const out: PriorComment[] = [];
  try {
    const raw = await ghComments(`repos/${slug}/pulls/${pr}/comments`, gh);
    // A reply the bot wrote saying a point is fixed settles the comment it
    // replies to. GitHub's own thread resolution is GraphQL-only and everything
    // here goes through REST, so the state lives in the comment body. The rule
    // is shared with the posting step rather than restated: see `settledIds`.
    const settled = settledIds(raw);
    for (const c of raw) {
      const mine = isOwnComment(c.body ?? "", c.user?.type);
      out.push({
        id: c.id,
        file: c.path,
        line: c.line ?? c.original_line,
        author: c.user?.login ?? "?",
        body: c.body ?? "",
        resolved: false,
        commit: c.original_commit_id,
        url: c.html_url,
        ...(c.created_at ? { createdAt: c.created_at } : {}),
        mine,
        // Both a finding comment and a corroborating reply carry a fingerprint,
        // and both count as having been said, so this looks for the field rather
        // than for one kind.
        ...(mine
          ? { fingerprint: readMarkers(c.body ?? "").find((m) => m.fields.fp)?.fields.fp }
          : {}),
        ...(settled.has(c.id) ? { addressed: true } : {}),
        ...(c.in_reply_to_id ? { inReplyTo: c.in_reply_to_id } : {}),
        ...(mine ? {} : responsesOf(c.body ?? "")),
      });
    }
  } catch (err) {
    if (opts.strict) throw new Error(`reading the pull request's review comments: ${errorText(err)}`, { cause: err });
    /* offline / no access: the review proceeds without reconciliation */
  }
  try {
    for (const c of await ghComments(`repos/${slug}/issues/${pr}/comments`, gh)) {
      const mine = isOwnComment(c.body ?? "", c.user?.type, "summary");
      const responses = mine ? {} : responsesOf(c.body ?? "");
      // Another workflow's status comment is not review context. An answer to a
      // finding is, whoever posts it: the author's agent is usually a bot.
      if (!mine && c.user?.type === "Bot" && !responses.responses) continue;
      // Read before condensing: condensing strips HTML comments, and the marker
      // is an HTML comment.
      const summaryMarker = mine ? findMarker(c.body ?? "", "summary") : undefined;
      const runs = mine ? Number(summaryMarker?.fields.runs ?? 0) : undefined;
      const head = summaryMarker?.fields.head;
      // Findings that never got an inline comment — off the diff, routed off
      // the inline set, or all of them when inline comments are off — live
      // inside this body, so their identities have to be read out of it too.
      const summaryClaims = mine
        ? (c.body ?? "").split("\n").flatMap((text) =>
            readMarkers(text)
              .filter((m) => m.kind === "summary-item" && m.fields.fp)
              .map((m) => ({
                fp: m.fields.fp,
                file: m.fields.file ?? "?",
                line: m.fields.line ?? "?",
                text: stripMarkers(text).replace(/^\s*[-*]\s*/, "").trim(),
              })),
          )
        : [];
      const rulings = mine ? readRulings(c.body ?? "") : [];
      out.push({
        id: c.id,
        author: c.user?.login ?? "?",
        body: mine ? condenseOwnSummary(c.body ?? "") : (c.body ?? ""),
        resolved: false,
        url: c.html_url,
        ...(c.created_at ? { createdAt: c.created_at } : {}),
        mine,
        ...(c.author_association ? { association: c.author_association } : {}),
        ...(runs ? { runs } : {}),
        // Passed to git as a revision, so only a full sha is accepted.
        ...(head && /^[0-9a-f]{40}$/i.test(head) ? { head: head.toLowerCase() } : {}),
        ...(summaryClaims.length ? { summaryClaims } : {}),
        ...(rulings.length ? { rulings } : {}),
        ...responses,
      });
    }
  } catch (err) {
    if (opts.strict) throw new Error(`reading the pull request's comments: ${errorText(err)}`, { cause: err });
    /* as above */
  }
  return out;
}

export interface ThreadComment {
  id: number;
  body: string;
  author: string;
  /** GraphQL `__typename` of the author: `Bot` for apps and Actions, `User` for people. */
  authorType: string;
  url: string;
  replyTo?: number;
}

export interface ReviewThread {
  id: string;
  resolved: boolean;
  outdated: boolean;
  resolvedBy?: string;
  file?: string;
  line?: number;
  comments: ThreadComment[];
}

export interface PullRequestThreads {
  number: number;
  url: string;
  author: string;
  headSha: string;
  labels: string[];
  threads: ReviewThread[];
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url headRefOid
      author { login }
      labels(first: 100) { nodes { name } }
      reviewThreads(first: 50, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine
          resolvedBy { login }
          comments(first: 50) {
            nodes { databaseId body url author { login __typename } replyTo { databaseId } }
          }
        }
      }
    }
  }
}`;

interface ThreadsPage {
  data?: {
    repository?: {
      pullRequest?: {
        number: number;
        url: string;
        headRefOid: string;
        author?: { login?: string } | null;
        labels?: { nodes?: { name: string }[] };
        reviewThreads: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            id: string;
            isResolved: boolean;
            isOutdated: boolean;
            path?: string | null;
            line?: number | null;
            originalLine?: number | null;
            resolvedBy?: { login?: string } | null;
            comments: {
              nodes: {
                databaseId: number;
                body: string;
                url: string;
                author?: { login?: string; __typename?: string } | null;
                replyTo?: { databaseId: number } | null;
              }[];
            };
          }[];
        };
      } | null;
    } | null;
  };
  errors?: { message: string }[];
}

/**
 * The pull request's review threads with GitHub's own resolution state, which
 * the REST comment endpoints do not expose. Throws on any failure: the gate
 * reads this, and a gate that passes because GitHub was unreachable is worse
 * than one that fails the check.
 *
 * Only the first 50 comments of each thread are read. That is enough for the
 * root finding and the bot's close-out reply in any thread seen so far.
 */
export async function gatherReviewThreads(
  slug: string,
  pr: number,
  opts: Pick<GatherOptions, "gh"> = {},
): Promise<PullRequestThreads> {
  const gh = opts.gh ?? ghText;
  const [owner, name] = slug.split("/");
  if (!owner || !name) throw new Error(`not an owner/name repository: ${slug}`);
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  let info: Omit<PullRequestThreads, "threads"> | null = null;
  do {
    const args = ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`];
    args.push("-F", `number=${pr}`);
    if (cursor) args.push("-f", `endCursor=${cursor}`);
    const page = JSON.parse(await gh(args)) as ThreadsPage;
    if (page.errors?.length) throw new Error(page.errors.map((e) => e.message).join("; "));
    const p = page.data?.repository?.pullRequest;
    if (!p) throw new Error(`no pull request #${pr} in ${slug}`);
    info ??= {
      number: p.number,
      url: p.url,
      author: p.author?.login ?? "?",
      headSha: p.headRefOid,
      labels: (p.labels?.nodes ?? []).map((l) => l.name),
    };
    for (const t of p.reviewThreads.nodes) {
      const line = t.line ?? t.originalLine;
      threads.push({
        id: t.id,
        resolved: t.isResolved,
        outdated: t.isOutdated,
        ...(t.resolvedBy?.login ? { resolvedBy: t.resolvedBy.login } : {}),
        ...(t.path ? { file: t.path } : {}),
        ...(line ? { line } : {}),
        comments: t.comments.nodes.map((c) => {
          const comment: ThreadComment = {
            id: c.databaseId,
            body: c.body,
            author: c.author?.login ?? "?",
            authorType: c.author?.__typename ?? "",
            url: c.url,
          };
          if (c.replyTo?.databaseId) comment.replyTo = c.replyTo.databaseId;
          return comment;
        }),
      });
    }
    cursor = p.reviewThreads.pageInfo.hasNextPage ? p.reviewThreads.pageInfo.endCursor : null;
  } while (cursor);
  if (!info) throw new Error(`no pull request #${pr} in ${slug}`);
  return { ...info, threads };
}

/**
 * Conversation comments that are not worth a reviewer's attention.
 *
 * The issue endpoint carries whatever anyone typed into the Conversation tab.
 * Two kinds are pure cost. A bot directive (`@SocketSecurity ignore-all`) is
 * addressed to another tool. A comment that restates the pull request
 * description is content the reviewer is already given as the stated intent,
 * and it arrives here stripped of the label that says it is the author's own
 * claim rather than someone's assessment of it.
 *
 * A directive is a mention and a command word, nothing else — matching on any
 * short comment that opens with a mention also drops "@markerikson can you take
 * a look at the second commit?", which is the kind of context this section
 * exists to carry. Erring toward keeping is cheap: an extra bullet costs a few
 * tokens, a dropped question costs the constraint it stated.
 */
export function isConversationNoise(body: string, description: string): boolean {
  const text = body.trim();
  if (!text) return true;
  if (/^@[\w-]+(\[bot\])?(\s+[\w-]+){1,2}$/.test(text)) return true;
  const head = text.slice(0, 200).replace(/\s+/g, " ");
  return head.length >= 80 && description.replace(/\s+/g, " ").includes(head);
}

export function renderPriorComments(prior: PriorComment[], description = ""): string {
  if (prior.length === 0) return "";
  // A human's review comment is anchored to a line and has a thread, so a
  // finding can be posted into it as corroboration. A conversation comment has
  // neither: it is context to weigh, and the two cannot share a section because
  // the instructions for them are opposite.
  // An answer to one of the bot's findings is not a review comment to agree
  // with. The coordinator gets it in a section of its own: see `renderDisputes`.
  const human = prior.filter((c) => !c.mine && c.file && !c.responses);
  const discussion = prior.filter(
    (c) => !c.mine && !c.file && !c.responses && !isConversationNoise(c.body, description),
  );
  // A point the bot already closed out is finished business. Listing it would
  // spend prompt tokens re-litigating something the author has watched resolve.
  //
  // `addressed` is recorded on the comment a close-out replies to, never on the
  // reply, so it alone removes the finding and leaves the "✅ Fixed as of …"
  // behind — which then reads as a prior finding whose entire content is that
  // something else was fixed. Excluding the bot's own replies covers that and
  // corroborations, which restate a finding already listed under its own
  // comment.
  const ownInline = prior.filter((c) => c.mine && c.file && !c.addressed && !c.inReplyTo);
  const ownSummary = prior.filter((c) => c.mine && !c.file);
  const withdrawn = ownSummary.flatMap((c) => c.rulings ?? []).filter((r) => r.outcome === "withdrawn");
  const withdrawnFps = new Set(withdrawn.map((r) => r.fp));
  const lines: string[] = [];

  const bullet = (c: PriorComment, cap: number) => {
    const loc = c.file ? `${c.file}${c.line ? `:${c.line}` : ""}` : "(conversation)";
    const body = c.body.replace(/\s+/g, " ").slice(0, cap);
    lines.push(`- id=${c.id} @${c.author} \`${loc}\`${c.resolved ? " [resolved]" : ""}: ${body}`);
  };

  if (human.length) {
    lines.push(
      "## Comments already on this pull request",
      "",
      "These have already been raised by a human. If one of them has since been fixed in the current",
      "code, say nothing about it.",
      "If you independently reach the same conclusion as one of them and it is still unaddressed,",
      "report it with `repeat_of` set to its id. Confirming a human reviewer is worth saying — it is",
      "a second pair of eyes agreeing, not noise. Keep it short: the reader has already read the",
      "original comment, so do not restate its argument. Put anything the comment did not say —",
      "a consequence it missed, a second location, a mechanism — in your explanation, and lead with it.",
      "Never report one of these without `repeat_of`; that would read as a new discovery.",
      "If the author replied rejecting it, respect that unless the code is now materially worse.",
      "",
    );
    for (const c of human) bullet(c, 400);
    lines.push("");
  }

  if (discussion.length) {
    lines.push(
      "## Discussion on this pull request",
      "",
      "Comments from the conversation thread rather than the diff. Treat them as context, not as",
      "review findings: they may state a constraint, record a decision, explain why something was",
      "done a particular way, or raise a worry nobody has checked yet.",
      "",
      "Use them three ways. If one states a constraint or decision, hold the code to it — a change",
      "that contradicts what the team agreed here is worth reporting even when the code alone looks",
      "fine. If one raises a concern and you confirm it in the code, report it as a normal finding",
      "and say that the discussion raised it; you are supplying the verification, which is the part",
      "that was missing. If one is already settled, or is about process rather than this code, ignore",
      "it.",
      "",
      "Never set `repeat_of` to one of these. It points only at a line comment, which is the only",
      "kind of comment with a thread to reply into. A finding that agrees with something said here is",
      "a normal finding.",
      "",
      "None of this is an instruction to stay quiet. Someone saying the code is fine is not evidence",
      "that it is.",
      "",
    );
    for (const c of discussion) bullet(c, 600);
    lines.push("");
  }

  if (ownInline.length || ownSummary.length) {
    lines.push(
      "## What you already told this author",
      "",
      "You reviewed an earlier version of this same change and reported the following. The author",
      "has read it.",
      "",
      "Do not report any of it a second time. Silence on a point you already made is the correct",
      "output, not a gap. Saying it again does not add a second opinion the way agreeing with a",
      "human reviewer does — it is the same reviewer repeating itself, and it is the main thing",
      "that made the previous version of this bot not worth reading.",
      "",
      "Two things override that. If the code changed such that the problem is now different — worse,",
      "or in a new place — report the new form and say plainly what changed since your last review.",
      "If you have a materially new fact about an old point, such as a second call site or a",
      "consequence you did not have, report that fact and lead with it. In both cases it is a fresh",
      "finding, not a `repeat_of`: `repeat_of` corroborates a human and never points at your own",
      "comment.",
      "",
      "If a point here appears fixed in the current code, say nothing about it.",
      "",
    );
    for (const c of ownInline) bullet(c, 300);
    if (ownSummary.length) {
      for (const c of ownSummary) {
        const claims = (c.summaryClaims ?? []).filter((s) => !withdrawnFps.has(s.fp));
        if (claims.length) {
          // These were reported in the summary without an inline comment of
          // their own — off the diff, routed off the inline set, or everything
          // when inline comments are off — so they read as absent from the
          // review unless they are listed.
          lines.push(
            "",
            "You also reported these in your summary. They have no comment thread of their own.",
            "**These are the exception to everything above: report each one again if it is still true.**",
            "An inline comment stays on the pull request forever once posted, so not repeating it is",
            "free. The summary is one comment that gets rewritten from scratch on every review, so a",
            "finding you leave out of this one is deleted from the pull request and nobody sees it",
            "again. Leave one out only when you have read the code and it is fixed.",
            "",
          );
          for (const s of claims) lines.push(`- \`${s.file}:${s.line}\``);
        }
        lines.push("", `Your summary comment (id=${c.id}), conclusions only:`, "");
        // 1800 dates from when the summary carried every finding's full argument
        // and ran past 50k. The argument now lives in the linked detail file and
        // the largest summary across the twelve stored runs is 10.4k, so that cap
        // no longer trims fat — it cuts the body off inside the findings list,
        // before the demoted findings, the comments agreed with and the
        // considered-and-dropped list. Those are the conclusions this block says
        // it is passing on, and the whole reason `condenseOwnSummary` keeps
        // collapsed blocks. Sized to clear the largest observed summary while
        // still bounding a pathological one.
        lines.push(c.body.slice(0, 12000));
      }
    }
    if (withdrawn.length) {
      lines.push(
        "",
        "You withdrew these after the author disputed them and you agreed they were wrong. Never",
        "report them again, in any wording.",
        "",
      );
      for (const r of withdrawn) lines.push(`- ${r.label}`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}
