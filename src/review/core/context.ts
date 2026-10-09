import { text } from "./lib/proc.ts";
import { readJson } from "./lib/io.ts";
import { findMarker, isOwnComment, readMarkers, settledIds } from "./lib/marker.ts";
import { SUBJECT } from "./config.ts";

// ---------------------------------------------------------------- context

export async function gitText(args: string[]): Promise<string> {
  return await text("git", ["-C", SUBJECT, "-c", "diff.renames=true", ...args]);
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

/** PR description plus commit subjects: the author's stated intent. */
export async function gatherIntent(slug: string, pr: string | undefined, base: string, head: string) {
  let title = "";
  let body = "";
  // A bare commit range has no description, so the commit subjects are the only
  // statement of intent there is.
  if (pr) {
    try {
      const meta = JSON.parse(await text("gh", ["api", `repos/${slug}/pulls/${pr}`])) as {
        title?: string;
        body?: string;
      };
      title = meta.title ?? "";
      body = meta.body ?? "";
    } catch {
      /* offline / no access: intent section degrades to commits only */
    }
  }
  const log = await gitText(["log", "--format=%s%n%b%n---", `${base}..${head}`]);
  return { title, body, commits: log.trim() };
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
  /**
   * On the bot's own summary comment: the findings reported inside its body
   * rather than as comments of their own, because they sit outside the diff.
   */
  summaryClaims?: { fp: string; file: string; line: string }[];
  /**
   * GitHub's account of the author's standing in this repository: `OWNER`,
   * `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE` and so on. Carried because
   * `/ai-review resume` raises the review budget, and the workflow's gate on
   * who may say that only governs which comments start a run — the count is
   * recomputed here from every comment on the pull request.
   */
  association?: string;
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
}

export async function ghComments(endpoint: string): Promise<GhComment[]> {
  return JSON.parse(await text("gh", ["api", "--paginate", endpoint])) as GhComment[];
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
 */
export function condenseOwnSummary(body: string): string {
  return body
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
export async function gatherPriorComments(slug: string, pr: string | undefined): Promise<PriorComment[]> {
  const fixture = process.env.PRIOR_FIXTURE;
  if (fixture) return await readJson<PriorComment[]>(fixture);
  // A bare commit range has no comment threads to reconcile against.
  if (!pr) return [];
  const out: PriorComment[] = [];
  try {
    const raw = await ghComments(`repos/${slug}/pulls/${pr}/comments`);
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
        mine,
        // Both a finding comment and a corroborating reply carry a fingerprint,
        // and both count as having been said, so this looks for the field rather
        // than for one kind.
        ...(mine
          ? { fingerprint: readMarkers(c.body ?? "").find((m) => m.fields.fp)?.fields.fp }
          : {}),
          ...(settled.has(c.id) ? { addressed: true } : {}),
          ...(c.in_reply_to_id ? { inReplyTo: c.in_reply_to_id } : {}),
        });
    }
  } catch {
    /* offline / no access: the review proceeds without reconciliation */
  }
  try {
    for (const c of await ghComments(`repos/${slug}/issues/${pr}/comments`)) {
      const mine = isOwnComment(c.body ?? "", c.user?.type, "summary");
      // Another workflow's status comment is not review context.
      if (!mine && c.user?.type === "Bot") continue;
      // Read before condensing: condensing strips HTML comments, and the marker
      // is an HTML comment.
      const runs = mine ? Number(findMarker(c.body ?? "", "summary")?.fields.runs ?? 0) : undefined;
      // Findings that never got an inline comment — off the diff, routed off
      // the inline set, or all of them when inline comments are off — live
      // inside this body, so their identities have to be read out of it too.
      const summaryClaims = mine
        ? readMarkers(c.body ?? "")
            .filter((m) => m.kind === "summary-item" && m.fields.fp)
            .map((m) => ({ fp: m.fields.fp, file: m.fields.file ?? "?", line: m.fields.line ?? "?" }))
        : [];
      out.push({
        id: c.id,
        author: c.user?.login ?? "?",
        body: mine ? condenseOwnSummary(c.body ?? "") : (c.body ?? ""),
        resolved: false,
        url: c.html_url,
        mine,
        ...(c.author_association ? { association: c.author_association } : {}),
        ...(runs ? { runs } : {}),
        ...(summaryClaims.length ? { summaryClaims } : {}),
      });
    }
  } catch {
    /* as above */
  }
  return out;
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
  const human = prior.filter((c) => !c.mine && c.file);
  const discussion = prior.filter(
    (c) => !c.mine && !c.file && !isConversationNoise(c.body, description),
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
        if (c.summaryClaims?.length) {
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
          for (const s of c.summaryClaims) lines.push(`- \`${s.file}:${s.line}\``);
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
    lines.push("");
  }

  return lines.join("\n") + "\n";
}
