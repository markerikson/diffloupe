import path from "node:path";
import { text } from "./lib/proc.ts";
import { removeIfPresent, writeJson, writeText } from "./lib/io.ts";
import { fingerprint, marker, stripMarkers } from "./lib/marker.ts";
import { anchorFor, loadHunks } from "./lib/hunks.ts";
import { code, fence } from "./lib/markdown.ts";
import { INLINE_MODE, repoName } from "./config.ts";
import { type Finding } from "./findings.ts";
import { type PriorComment } from "./context.ts";
import { type Walkthrough } from "./prompts.ts";
import { classifySurface, SURFACE_RANK, primarySurface, SURFACE_TAG, CONF, SEV, EFFORT_TAG, anchorCovers, CAT, leadSentences } from "./surface.ts";
import { mergeRisk, prodRisk, TIER_TITLE, type Verdict } from "./verdict.ts";

const RISK_DOT = { high: "🔴", moderate: "🟡", low: "🟢" } as const;
import { MAX_POSTED } from "./coordinate.ts";

export function renderReview(o: {
  /** Absent for a commit-range review, which is never posted anywhere. */
  pr?: string | undefined;
  head: string;
  findings: Finding[];
  intentAlignment?: { summary?: string | undefined; unstated?: string[] | undefined; missing?: string[] | undefined } | undefined;
  dropped?: { title: string; reason: string }[] | undefined;
  stats: Record<string, unknown>;
  walkthrough?: Walkthrough | undefined;
  repo?: string | undefined;
  prior?: PriorComment[] | undefined;
  /** Ids of the bot's own earlier comments that the current code has fixed. */
  resolved?: { id: number; note?: string | undefined }[] | undefined;
  /** How many reviews this pull request will have had once this one is posted. */
  runs?: number | undefined;
  /**
   * Every file the pull request changes, not only the ones a finding names.
   * Decides which findings are worth a comment of their own: see
   * `primarySurface`. A change that is entirely tooling has no shipping code to
   * make room for, and the surfaces it does not touch cannot be read off the
   * findings alone.
   */
  changedFiles?: string[] | undefined;
  /**
   * Name the detail document is written under, so the comment can tell a reader
   * which file to open inside the artifact. Named by the caller because the
   * caller owns the tag the artifact files are keyed on.
   */
  detailFile?: string | undefined;
  /** Where the detail document sits on disk, shown when there is no Actions run to link to. */
  detailPath?: string | undefined;
  /**
   * Set when the slice reviewers did not run at all, so an empty finding list
   * carries no information about the code. Without it the comment reads as an
   * all-clear on a diff nobody reviewed, which is the one thing this pipeline
   * must never say.
   */
  noReviewers?: boolean | undefined;
  /**
   * Code files no reviewer read: over the slice cap, or in a slice that failed.
   * Shown outside every fold, since a short finding list means something
   * different when part of the diff was never looked at.
   */
  unreviewed?: { overCap: string[]; failed: string[]; budget?: string[] } | undefined;
  /** What the slice reviewers verified and found correct, in slice order. */
  checked?: string[] | undefined;
  /** Findings the review stands behind but did not post because of `MAX_POSTED`. */
  overCap?: Finding[] | undefined;
  /** See `INLINE_MODE`. Defaults to summary-only. */
  inlineMode?: "tier" | "none" | undefined;
}): {
  summary: string;
  /**
   * Everything the summary comment leaves out: the full walkthrough, the whole
   * inferred-intent block, and every finding's argument and citations. Written
   * beside the preview as its own file and linked from the comment, so trimming
   * the comment moves detail rather than destroying it.
   */
  detail: string;
  inline: string[];
  ordered: Finding[];
  replies: {
    comment_id: number;
    author?: string | undefined;
    url?: string | undefined;
    finding?: Finding | undefined;
    body: string;
  }[];
} {
  const slug = o.repo ?? repoName;
  const link = (file: string, line?: number) =>
    `https://github.com/${slug}/blob/${o.head}/${file}${line ? `#L${line}` : ""}`;
  const loc = (file: string, line?: number, label?: string) => {
    const text = label ?? `${file.split("/").pop()}${line ? `:${line}` : ""}`;
    // A local review has no pushed commit to link to, so the location stays plain text.
    if (!o.pr) return text.includes("`") ? text : `\`${text}\``;
    return `[${text}](${link(file, line)})`;
  };
  // Severity, then how far the code is from production, then confidence. Kept
  // here rather than left to the caller so a re-render of a stored run orders
  // the same way a fresh review does.
  const sorted = [...o.findings].sort(
    (a, b) =>
      (SEV[a.severity]?.rank ?? 9) - (SEV[b.severity]?.rank ?? 9) ||
      SURFACE_RANK[classifySurface(a.file)] - SURFACE_RANK[classifySurface(b.file)] ||
      CONF.indexOf(a.confidence) - CONF.indexOf(b.confidence),
  );

  // A finding a human already raised does not become an inline comment — that
  // would put a second comment on a line someone has already commented on. It
  // moves to its own section, where agreeing with the reviewer is the point.
  const echoed = sorted.filter((f) => f.repeat_of);
  const reported = sorted.filter((f) => !f.repeat_of);
  // A finding about code this pull request does not touch cannot be an inline
  // comment at all — GitHub rejects the entire review over one such anchor. It
  // moves into the summary rather than being dropped, because the best result
  // this pipeline has produced was exactly that shape: a stale exec path in a
  // file the PR never opened.
  const fresh = reported.filter((f) => f._anchor?.kind !== "off-diff");
  const priorById = new Map((o.prior ?? []).map((c) => [c.id, c]));
  const summaryMarker = marker("summary", {
    ...(o.pr ? { pr: o.pr } : {}),
    ...(o.runs ? { runs: o.runs } : {}),
    head: o.head,
  });

  const counts = reported.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});

  /**
   * One finding, written out in full.
   *
   * Reading order is deliberate: the claim, then one line of provenance, then
   * the concrete evidence. The full argument is collapsed, because a reviewer
   * who already believes the evidence should not have to scroll past it.
   *
   * `inline` renders a GitHub review-comment body attached to a line.
   * `summary` renders the same finding into the summary comment, for findings
   * that have no line to attach to — so the location becomes a link and the
   * suggestion becomes a plain code block, since `suggestion` blocks are only
   * applicable on a review comment.
   */
  /**
   * `label` replaces the title in the heading. The summary lists every finding
   * as a numbered bullet before this runs, so repeating the bare title here
   * would print it twice with nothing to tie the two together.
   */
  const findingBody = (f: Finding, mode: "inline" | "summary", label?: string): string => {
    const b: string[] = [];
    const sev = SEV[f.severity]?.badge ?? f.severity;
    const cat = CAT[f.category] ?? f.category;
    const span = f.end_line && f.end_line !== f.line ? `-${f.end_line}` : "";
    const where =
      mode === "summary"
        ? loc(f.file, f.line, `${f.file}:${f.line}${span}`)
        : `\`${f.file}:${f.line}${span}\``;

    b.push(`${mode === "summary" ? "#####" : "####"} ${label ?? f.title}`);
    b.push("");
    b.push(
      [
        sev,
        cat,
        EFFORT_TAG[f.effort ?? ""],
        `confidence: ${f.confidence}`,
        where,
        SURFACE_TAG[classifySurface(f.file)],
        f.preexisting ? "pre-existing" : "",
      ]
        .filter(Boolean)
        .join(" · "),
    );

    // A snapped comment sits on a line that is not the line it is about, so it
    // has to say so. Without this the reader checks the wrong code and dismisses
    // a correct finding.
    if (mode === "inline" && f._anchor?.kind === "off-hunk") {
      b.push("");
      b.push(
        `> Posted here because GitHub only accepts comments on changed lines. The code this is about is at \`${f.file}:${f.line}${span}\`.`,
      );
    }

    // Only the consequence is shown unexpanded. The argument and the citations
    // are both one click away, in the order a doubting reader wants them.
    b.push("");
    b.push(f.impact?.trim() || leadSentences(f.explanation));

    if (f.explanation) {
      b.push("");
      b.push("<details><summary>Why this is a problem</summary>");
      b.push("");
      b.push(f.explanation);
      b.push("");
      b.push("</details>");
    }
    if (f.evidence || f.cross_file_refs?.length) {
      b.push("");
      b.push("<details><summary>Evidence</summary>");
      b.push("");
      if (f.evidence) b.push(f.evidence);
      if (f.cross_file_refs?.length) {
        b.push("");
        b.push("Also read:");
        for (const r of f.cross_file_refs) b.push(`- \`${r}\``);
      }
      b.push("");
      b.push("</details>");
    }

    if (f.suggested_code) {
      // Two forms of the same fix. The diff is for reading: a bare suggestion
      // block shows the replacement with no sign of what it replaces, so the
      // reader has to hold the original in their head or scroll away from the
      // comment, and most often just does not apply it. The suggestion block is
      // for applying, and only GitHub review comments can carry one.
      if (f._original !== undefined) {
        const del = f._original.replace(/\n$/, "").split("\n").map((l) => `-${l}`);
        const add = f.suggested_code.replace(/\n$/, "").split("\n").map((l) => `+${l}`);
        b.push("");
        b.push("<details><summary>What this changes</summary>");
        b.push("");
        b.push(fence([...del, ...add].join("\n"), "diff"));
        b.push("");
        b.push("</details>");
      }
      b.push("");
      // GitHub applies a suggestion to the lines the *comment* sits on, which is
      // the anchor, not the lines the model meant to replace. Those differ
      // whenever a finding was snapped to a nearby changed line, or its span
      // straddled two hunks and collapsed to one end. Committing such a
      // suggestion overwrites the wrong code, so it is only offered as
      // applicable when the anchor covers exactly the replaced range.
      const applicable = mode === "inline" && anchorCovers(f);
      if (applicable) {
        b.push("_Applying this commits it as written — read it first._");
        b.push("");
      } else if (mode === "inline") {
        const span = f.end_line && f.end_line !== f.line ? `${f.line}-${f.end_line}` : `${f.line}`;
        b.push(`_Replaces ${code(`${f.file}:${span}`)}. Not offered as a committable suggestion because this comment is anchored elsewhere._`);
        b.push("");
      }
      b.push(fence(f.suggested_code, applicable ? "suggestion" : ""));
    } else if (f.suggestion) {
      b.push("");
      b.push(`_Suggested fix:_ ${f.suggestion}`);
    }
    b.push("");
    b.push(
      mode === "inline"
        ? marker("inline", { file: f.file, line: f.line, fp: fingerprint(f.file, f.title) })
        : // A finding rendered into the summary has no comment of its own to carry
          // its fingerprint, so without this it is invisible to every check that
          // reads what was already said.
          marker("summary-item", { file: f.file, line: f.line, fp: fingerprint(f.file, f.title) }),
    );
    return b.join("\n");
  };

  // What is read without a click, and what gets a comment of its own.
  //
  // The split is relative to the change: `primarySurface` picks the most
  // production-proximate surface the pull request touches at all, and anything
  // at or above it stays visible. On a change that touches `src`, a finding in a
  // helper script is a distraction and collapses. On a change that is entirely
  // tooling, those same findings are the whole point and stay up.
  //
  // `<=` rather than `===`: a lower tier only ever widens the visible set, so a
  // finding in shipping code is never demoted by this rule.
  //
  // Grouping by file rather than listing flat: two findings in one file are one
  // place to look, and the file is the part a reader scans for.
  const flat = (t: string) => t.replace(/\s+/g, " ").trim();
  const tier = primarySurface(o.changedFiles ?? [], reported);
  const inTier = (f: Finding) => SURFACE_RANK[classifySurface(f.file)] <= SURFACE_RANK[tier];
  const tierFindings = reported.filter(inTier);
  const otherFindings = reported.filter((f) => !inTier(f));
  // Which findings get an inline comment of their own. Computed up here rather
  // than beside the payload assembly because the bullet list needs the same
  // answer: a finding with an inline comment carries its fingerprint there, and
  // one without carries it on its summary bullet — never both, or the prompt
  // tells the next reviewer to repeat a claim it can already see.
  const posted = (o.inlineMode ?? "none") === "none" ? [] : fresh.filter(inTier);
  const postedSet = new Set(posted);
  // Numbered across both groups in render order, so a bullet in either list can
  // point at its evidence block and the numbers never collide.
  const evidenceOrder = [...tierFindings, ...otherFindings];
  const evidenceNo = new Map<Finding, number>();
  for (const f of evidenceOrder) evidenceNo.set(f, evidenceNo.size + 1);

  const s: string[] = [];
  s.push(`### Review of \`${o.head.slice(0, 12)}\``);
  s.push("");
  const skippedFiles = o.unreviewed?.overCap ?? [];
  const failedFiles = o.unreviewed?.failed ?? [];
  const budgetFiles = o.unreviewed?.budget ?? [];
  const partial = skippedFiles.length + failedFiles.length + budgetFiles.length > 0;
  if (partial) {
    const parts = [
      skippedFiles.length ? `${skippedFiles.length} over the slice cap` : "",
      failedFiles.length ? `${failedFiles.length} in a reviewer that failed` : "",
      budgetFiles.length ? `${budgetFiles.length} skipped at the cost limit` : "",
    ].filter(Boolean);
    const named = [...failedFiles, ...budgetFiles, ...skippedFiles];
    const shown = named.slice(0, 5).map((f) => `\`${f}\``).join(", ");
    const more = named.length > 5 ? `, and ${named.length - 5} more` : "";
    s.push(
      `⚠️ **Partial review:** ${named.length} changed code ${named.length === 1 ? "file was" : "files were"} not reviewed` +
        ` (${parts.join(", ")}): ${shown}${more}.`,
    );
    s.push("");
  }
  if (reported.length === 0) {
    s.push(
      o.noReviewers
        ? "No reviewer ran on this change. What follows is the reading guide only — it is not a statement that the code is clean."
        : partial
          ? "No new issues found in the reviewed files."
          : "No new issues found in the changed files.",
    );
  } else {
    // Computed rather than asked for. It costs no tokens, and the same findings
    // always produce the same verdict — which matters on a comment that is
    // edited in place across many pushes, where an answer that drifts for no
    // visible reason reads as the bot changing its mind.
    //
    // Counted over `reported`, the same list the severity tally and every bullet
    // below are built from. `sorted` also holds the echoed findings, which are
    // agreements with a human's existing comment and appear in no bullet list —
    // counting them here makes the headline disagree with the tally printed two
    // lines under it, over findings the reader cannot find anywhere in between.
    const line = (v: Verdict) => `${RISK_DOT[v.level]} **${v.label}** — ${v.detail}`;
    s.push(line(mergeRisk(reported)));
    s.push("");
    // Stated up here next to merge risk because it is the one line that decides
    // whether the rest of this comment is worth opening. Severity is deliberately
    // not folded in: a blocker in a test helper is still not a production risk,
    // and collapsing the two axes is what made the old single list unreadable.
    s.push(line(prodRisk(reported.map((f) => ({ severity: f.severity, preexisting: f.preexisting, surface: classifySurface(f.file) })))));
    s.push("");
    s.push(
      Object.entries(SEV)
        .filter(([k]) => counts[k])
        .map(([k, v]) => `${v.badge}: ${counts[k]}`)
        .join(" · "),
    );
  }
  s.push("");

  const w = o.walkthrough;
  const wi = w?.intent;
  const ia = o.intentAlignment;

  // Inferred intent: the verdict is a bullet, the reasoning is collapsed.
  const ALIGN: Record<string, string> = {
    aligned: "✅ Matches the description",
    partial: "⚠️ Partly matches the description",
    misaligned: "❌ Does not match the description",
  };
  const unstated = [...(wi?.unstated ?? []), ...(ia?.unstated ?? [])];
  const missing = [...(wi?.missing ?? []), ...(ia?.missing ?? [])];
  // The badge comes from the walkthrough call and the sentence beside it from
  // the coordinator. They run concurrently and neither sees the other's output.
  // The coordinator is told to write its summary sentence only when the diff
  // diverges from the description, so a non-empty sentence is a divergence
  // claim, and rendering it next to the walkthrough's "matches" badge joins two
  // contradicting judgements with an em dash. The stricter one wins.
  const alignment = wi?.alignment === "aligned" && ia?.summary ? "partial" : wi?.alignment;
  const verdict = alignment ? ALIGN[alignment] : undefined;
  const oneLine = ia?.summary ?? wi?.mismatches?.[0];

  // Orientation is collected here and pushed below the findings, so the answer
  // to "is anything wrong" comes before the answer to "what is this change".
  // A reader who opens the comment on a push is checking the former; making them
  // read a description of their own pull request first is a tax on the common
  // case. Kept as its own array because the block below also fills the detail
  // document, and the two are written in one pass to stay in step.
  const orient: string[] = [];

  // The detail document. Assembled alongside the comment rather than by a second
  // render so the two cannot drift: anything pushed here is exactly what was left
  // out above, and the numbering shared with the bullets stays meaningful.
  const d: string[] = [];
  d.push(`# Review of \`${o.head.slice(0, 12)}\`${o.pr ? ` — PR #${o.pr}` : ""}`);
  d.push("");
  d.push("Everything the summary comment links to rather than carries.");
  d.push("");

  if (verdict || oneLine || wi?.inferred || unstated.length || missing.length) {
    orient.push(
      `**Intent:** ${verdict ?? "ℹ️ Not assessed"}${oneLine ? ` — ${oneLine}` : ""}`,
    );
    // A taste of the reading, not the reading. Enough to tell whether the full
    // account is worth opening; the rest is one link away.
    if (wi?.inferred) orient.push("", `**What it does:** ${leadSentences(wi.inferred, 320)}`);
    orient.push("");

    d.push("## What the change actually does, read from the code");
    d.push("");
    if (wi?.inferred) d.push(wi.inferred, "");
    if (wi?.matches?.length) {
      d.push("Description holds up on:");
      for (const m of wi.matches) d.push(`- ${m}`);
      d.push("");
    }
    if (wi?.mismatches?.length) {
      d.push("Description does not hold up on:");
      for (const m of wi.mismatches) d.push(`- ${m}`);
      d.push("");
    }
    if (unstated.length) {
      d.push("In the diff but not in the description:");
      for (const u of unstated) d.push(`- ${u}`);
      d.push("");
    }
    if (missing.length) {
      d.push("Described but not accomplished:");
      for (const m of missing) d.push(`- ${m}`);
      d.push("");
    }
  }

  // Reads as a sequence: what the change is meant to do, what it actually does,
  // where to look hardest, which file to open first.
  //
  // Pushed here rather than inside the intent block above because it comes from
  // the walkthrough, not from the intent comparison. Gating it on whether the
  // description could be assessed dropped it on every review that had no
  // description to compare against — which is when a reader most needs telling
  // where to look.
  if (w?.focus) orient.push(`**What to focus on:** ${w.focus}`, "");

  const chapters = w?.chapters ?? [];
  const stopCount = chapters.reduce((n, c) => n + (c.stops?.length ?? 0), 0);
  if (w?.start_here?.length || stopCount) {
    const ICON: Record<string, string> = {
      bug: "🐛", wrench: "🔧", path: "🛤️", flask: "🧪", doc: "📄", gear: "⚙️",
    };
    const IMP: Record<string, string> = { critical: " 🔴", normal: "", context: " _(context)_" };
    // Only the entry points stay in the comment. They are a handful of lines and
    // they answer "where do I open first", which is the question a reader has
    // before they have decided to read anything. The chapter-by-chapter tour is
    // the largest single block in the comment and is written for someone who has
    // already decided — that reader can follow a link.
    if (w?.start_here?.length) {
      orient.push("**Start here**");
      orient.push("");
      for (const sh of w.start_here) {
        orient.push(`1. ${loc(sh.file, undefined, `\`${sh.file}\``)} — ${sh.why}`);
      }
      orient.push("");
    }

    if (stopCount || w?.support?.length) {
      d.push(
        `## Guided walkthrough — ${chapters.length} ${chapters.length === 1 ? "part" : "parts"}, ${stopCount} ${stopCount === 1 ? "stop" : "stops"}`,
      );
      d.push("");
    }
    let n = 0;
    for (const c of chapters) {
      d.push(`### ${ICON[c.icon ?? ""] ?? "▸"} ${c.title}`);
      if (c.blurb) d.push("", `_${c.blurb}_`);
      d.push("");
      for (const st of c.stops ?? []) {
        n++;
        d.push(`**${n}. ${st.title}**${IMP[st.importance ?? "normal"] ?? ""}`);
        if (st.prose) d.push("", st.prose);
        if (st.locations?.length) {
          d.push(
            "",
            `↳ ${st.locations.map((l) => loc(l.file, l.line, l.label)).join(" · ")}`,
          );
        }
        d.push("");
      }
    }
    if (w?.support?.length) {
      d.push("### Safe to skim");
      d.push("");
      for (const sp of w.support) {
        const files = sp.files.map((f) => `\`${f}\``).join(", ");
        d.push(`- ${files} — ${sp.reason}`);
      }
      d.push("");
    }
  }

  const bulletList = (list: Finding[]) => {
    const byFile = new Map<string, Finding[]>();
    for (const f of list) {
      const group = byFile.get(f.file);
      if (group) group.push(f);
      else byFile.set(f.file, [f]);
    }
    const out: string[] = [];
    for (const [file, group] of byFile) {
      out.push(`- \`${file}\``);
      for (const f of group) {
        const sev = SEV[f.severity]?.badge ?? f.severity;
        // An off-diff finding has no line in this pull request, so the location
        // has to be a permalink rather than a bare line number.
        const where =
          f._anchor?.kind === "off-diff"
            ? `${loc(f.file, f.line, `L${f.line}`)} 📎 outside the diff`
            : loc(f.file, f.line, `L${f.line}`);
        // The fingerprint rides on the bullet, not on the argument below it.
        // The argument now lives in a linked file that GitHub never sees, and
        // every check for "have I said this already" reads the posted comment —
        // so a marker anywhere else is a marker that does not exist.
        //
        // Only for findings without an inline comment: an inline comment carries
        // the fingerprint itself, and a bullet marker on top of it makes the
        // next run's prompt list the same claim both as "do not repeat" (the
        // inline comment) and as "report again if still true" (the summary
        // claim). One home per fingerprint.
        const fp = postedSet.has(f)
          ? ""
          : ` ${marker("summary-item", { file: f.file, line: f.line, fp: fingerprint(f.file, f.title) })}`;
        out.push(`  - ${sev} ${flat(f.title)} — ${where} · _[${evidenceNo.get(f)}]_${fp}`);
      }
    }
    return out;
  };

  // Titled by tier. "Prod risk" would be a false claim on a change that ships
  // nothing, and the reader of a tooling change still needs a name for the list
  // that matters.
  if (tierFindings.length) {
    s.push(`#### ${TIER_TITLE[tier]} (${tierFindings.length})`);
    s.push("");
    s.push(...bulletList(tierFindings));
    s.push("");
  }

  if (otherFindings.length) {
    s.push(
      `<details><summary>Everything else (${otherFindings.length}) — lower-risk surfaces</summary>`,
    );
    s.push("");
    s.push(...bulletList(otherFindings));
    s.push("");
    s.push("</details>");
    s.push("");
  }

  const overCap = o.overCap ?? [];
  if (overCap.length) {
    s.push(
      `➕ ${overCap.length} more ${overCap.length === 1 ? "finding" : "findings"} past the ${MAX_POSTED}-finding cap,` +
        " listed under “Past the cap” in the detail file.",
    );
    s.push("");
  }

  const checked = o.checked ?? [];

  s.push(...orient);

  // Corroborations are collapsed whatever their severity: they are posted into
  // the human's own thread, so the reader who cares has already been notified.
  if (echoed.length) {
    s.push(
      `<details><summary>Agreeing with ${echoed.length} existing review ${echoed.length === 1 ? "comment" : "comments"}</summary>`,
    );
    s.push("");
    for (const f of echoed) {
      const c = priorById.get(f.repeat_of!);
      const who = c ? `@${c.author}` : "an earlier review comment";
      const ref = c?.url ? `[${who}](${c.url})` : who;
      const sev = SEV[f.severity]?.badge ?? f.severity;
      s.push(`- ${sev} ${flat(f.title)} — \`${f.file}:${f.line}\` _— agrees with ${ref}_`);
    }
    s.push("");
    s.push("</details>");
    s.push("");
  }

  // The bullets carry the claim; this carries the argument. Split because the
  // claim is what gets scanned and the argument is what gets checked, and only
  // a reader who has decided a claim is worth checking wants the second one.
  if (evidenceOrder.length) {
    d.push("## Evidence and reasoning");
    d.push("");
    d.push("Numbered to match the bullets in the summary comment.");
    d.push("");
    for (const f of evidenceOrder) {
      d.push(findingBody(f, "summary", `[${evidenceNo.get(f)}] ${flat(f.title)}`));
      d.push("");
    }
  }

  if (overCap.length) {
    d.push("## Past the cap");
    d.push("");
    d.push(
      `Findings the review kept but did not post, because a review posts at most ${MAX_POSTED}.` +
        " Ranked below the posted ones by severity, surface and confidence.",
    );
    d.push("");
    for (const f of overCap) {
      d.push(findingBody(f, "summary", flat(f.title)));
      d.push("");
    }
  }

  if (checked.length) {
    d.push("## What the reviewers checked");
    d.push("");
    d.push("Claims each reviewer verified against the code and found correct.");
    d.push("");
    for (const c of checked) d.push(`- ${c}`);
    d.push("");
  }

  // Where the argument went. Uncollapsed on purpose: the comment now makes
  // claims whose backing is not in it, and a reader who cannot see how to reach
  // that backing has been given assertions instead of a review.
  //
  // The run page rather than a direct artifact link: the artifact is uploaded by
  // a later step than the one that renders this, so its id does not exist yet,
  // and the run URL is derivable from the environment with nothing threaded
  // through. Outside Actions there is no run to point at, and the file is
  // already on disk next to the preview, so the link degrades to its name.
  const runId = process.env.GITHUB_RUN_ID;
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const detailName = o.detailFile ?? "review-detail.md";
  if (evidenceOrder.length || stopCount || overCap.length || checked.length > 8) {
    s.push(
      runId
        ? `📄 **[Full review detail](${server}/${slug}/actions/runs/${runId})** — download the` +
            ` \`${artifactName(o.pr ?? "", o.head)}\` artifact and open \`${detailName}\`` +
            " for the walkthrough and the evidence behind each finding. Artifacts expire 90 days" +
            " after the run."
        : `📄 Full walkthrough and evidence: \`${o.detailPath ?? detailName}\`.`,
    );
    s.push("");
  }

  // A short or empty list says little on its own: it could be a clean change or
  // a reviewer that did not look hard. What was checked is what tells those
  // apart. With several findings the findings already show where the reviewers
  // went, so the list stays in the detail file. Collapsed because each claim
  // carries its locations and the list runs long.
  if (checked.length && reported.length <= 2 && !o.noReviewers) {
    s.push(`<details><summary>What the reviewers checked (${checked.length})</summary>`);
    s.push("");
    for (const c of checked.slice(0, 8)) s.push(`- ${c}`);
    if (checked.length > 8) s.push(`- …and ${checked.length - 8} more in the detail file`);
    s.push("");
    s.push("</details>");
    s.push("");
  }

  if (o.dropped?.length) {
    s.push("<details><summary>Findings considered and dropped during verification</summary>");
    s.push("");
    for (const d of o.dropped) s.push(`- **${d.title}** — ${d.reason}`);
    s.push("");
    s.push("</details>");
    s.push("");
  }

  s.push("<details><summary>Review details</summary>");
  s.push("");
  for (const [k, v] of Object.entries(o.stats)) s.push(`- ${k}: ${v}`);
  s.push("");
  s.push("</details>");
  // Invisible, and the only reason the next push updates this comment instead
  // of adding another one below it.
  s.push("");
  s.push(summaryMarker);

  // These two must stay index-parallel: `writeArtifacts` pairs `ordered[i]` with
  // `inline[i]` to build both the preview and the review payload. `posted` is
  // computed with the buckets above because the bullet list also needs it.
  const inline = posted.map((f) => findingBody(f, "inline"));

  // Corroborations go back into the thread that raised them, not onto the line
  // as a second comment. Deliberately thinner than an inline finding: the
  // reader of that thread has already read the argument.
  // `finding` is absent on the resolution replies appended below: those close
  // out a comment rather than restate one.
  const replies: {
    comment_id: number;
    author?: string | undefined;
    url?: string | undefined;
    finding?: Finding | undefined;
    body: string;
  }[] = echoed.map((f) => {
    const id = f.repeat_of!;
    const c = priorById.get(id);
    const b: string[] = [];
    b.push(
      `Checked this against \`${o.head.slice(0, 12)}\` — still open. ${SEV[f.severity]?.badge ?? f.severity}`,
    );
    const lead = f.impact?.trim() || leadSentences(f.explanation, 240);
    if (lead) b.push("", lead);
    const rest = [f.explanation, f.evidence].filter(Boolean).join("\n\n");
    if (rest) {
      b.push("", "<details><summary>What I found</summary>", "", rest, "", "</details>");
    }
    b.push("", marker("reply", { of: id, fp: fingerprint(f.file, f.title) }));
    return { comment_id: id, author: c?.author, url: c?.url, finding: f, body: b.join("\n") };
  });

  // Closing out its own earlier comments. Without this a fixed point simply goes
  // quiet, which reads the same as the bot losing track of it. The marker is
  // also how the next run knows the thread is finished and leaves it out of the
  // prompt — GitHub's own thread resolution is GraphQL-only, and everything here
  // is posted over REST.
  for (const r of o.resolved ?? []) {
    const c = priorById.get(r.id);
    // `file` is required, not incidental: only a review comment has a thread to
    // reply into. The pipeline filters these before calling, but rerender.ts
    // replays stored run records straight through here, so the guard lives at
    // the point that builds the call.
    if (!c?.mine || !c.file) continue;
    const note = r.note?.trim();
    replies.push({
      comment_id: r.id,
      author: c.author,
      url: c.url,
      body: [
        `✅ Fixed as of \`${o.head.slice(0, 12)}\`.${note ? ` ${note}` : ""}`,
        "",
        marker("reply", { of: r.id, addressed: 1 }),
      ].join("\n"),
    });
  }

  return {
    summary: fitComment(s.join("\n"), summaryMarker),
    // Not passed through `fitComment`: it is a file, not a comment, so the
    // 65,536-byte limit that forces truncation does not apply to it. That is the
    // point of splitting them — the detail that used to be dropped on a large
    // review now survives somewhere.
    detail: d.join("\n"),
    inline,
    ordered: posted,
    replies,
  };
}

/**
 * Reads the code a suggested fix would replace, so the comment can show a diff.
 *
 * `system.md` defines `suggested_code` as the literal replacement for lines
 * `line` through `end_line`, which makes the original side exactly that slice of
 * the file at the head commit. No model tokens are spent producing it.
 *
 * Best effort throughout: a finding whose file or line range cannot be read
 * keeps the plain suggestion block it had before.
 */
export async function withOriginalText(repoDir: string, head: string, findings: Finding[]): Promise<Finding[]> {
  const wanted = findings.filter((f) => f.suggested_code);
  if (wanted.length === 0) return findings;
  const cache = new Map<string, string[] | null>();
  const out: Finding[] = [];
  for (const f of findings) {
    if (!f.suggested_code) {
      out.push(f);
      continue;
    }
    if (!cache.has(f.file)) {
      try {
        cache.set(f.file, (await text("git", ["-C", repoDir, "show", `${head}:${f.file}`])).split("\n"));
      } catch {
        cache.set(f.file, null);
      }
    }
    const lines = cache.get(f.file);
    const last = f.end_line !== undefined ? Math.max(f.line, f.end_line) : f.line;
    const first = f.end_line !== undefined ? Math.min(f.line, f.end_line) : f.line;
    if (!lines || first < 1 || last > lines.length) {
      out.push(f);
      continue;
    }
    out.push({ ...f, _original: lines.slice(first - 1, last).join("\n") });
  }
  return out;
}

/** GitHub rejects an issue comment body longer than this. */
export const COMMENT_LIMIT = 65536;

/**
 * Keeps the summary inside GitHub's size limit.
 *
 * Findings that cannot be anchored to a diff line are written out in full here
 * rather than dropped, so the summary is no longer bounded by the walkthrough:
 * ten of them plus a long walkthrough can pass 64 KB.
 *
 * The trailing marker is re-appended unconditionally. Truncating it away would
 * not fail loudly — it would make the next push unable to find this comment and
 * post a second one, which is the exact behaviour this pipeline exists to stop.
 */
export function fitComment(body: string, tail: string): string {
  if (body.length <= COMMENT_LIMIT) return body;
  const notice =
    "\n\n---\n\n_Truncated to fit GitHub's comment size limit. The full review is in the run artifact._\n\n";
  // The closing tags added below are part of the result, so the budget has to
  // cover them before the cut is chosen. A prefix cannot have more unclosed
  // `<details>` than the whole body has `<details>`, so that count bounds them.
  const closer = "\n</details>";
  const reserve = ((body.match(/<details/g) ?? []).length + 1) * closer.length;
  const room = COMMENT_LIMIT - notice.length - tail.length - reserve - 1;
  // Cut at a blank line so the result does not end inside a `<details>` block
  // or half a sentence.
  const head = body.slice(0, room);
  const cut = head.lastIndexOf("\n\n");
  const kept = head.slice(0, cut > room / 2 ? cut : head.length);
  // A cut inside a collapsed block leaves `<details>` open, which swallows the
  // notice below it into the collapsed region.
  const open = (kept.match(/<details/g) ?? []).length - (kept.match(/<\/details>/g) ?? []).length;
  const close = open > 0 ? `\n${closer.repeat(open)}` : "";
  return `${kept}${close}${notice}${tail}`;
}

/** The name the workflow uploads a pull request review's files under. */
export function artifactName(pr: string | number, head: string): string {
  return `ai-code-review-${pr}-${head.slice(0, 9)}`;
}

/** File the full findings Markdown is saved under in the run artifact. */
export const FINDINGS_FILE = "findings.md";

const REVIEW_DETAILS_FOLD = "<details><summary>Review details</summary>";

/**
 * Puts a collapsed, fenced copy of every finding into the summary comment,
 * before the "Review details" fold, so GitHub's copy button on the code block
 * copies them all. All or nothing: `fitComment` closes open `<details>` but not
 * code fences, so a cut inside the block would break the rest of the comment.
 * When the block does not fit, one line pointing at the artifact goes in
 * instead, and when even that does not fit the summary is returned unchanged.
 */
export function insertCopyBlock(
  summary: string,
  markdown: string,
  opts: { artifact?: string | undefined; limit?: number } = {},
): string {
  const limit = opts.limit ?? COMMENT_LIMIT;
  const block = [
    "<details><summary>Copy all findings as Markdown</summary>",
    "",
    fence(markdown, "markdown"),
    "",
    "</details>",
  ].join("\n");
  const pointer = opts.artifact
    ? `_All findings as Markdown are too long for this comment: download the \`${opts.artifact}\` artifact and open \`${FINDINGS_FILE}\`._`
    : `_All findings as Markdown are too long for this comment: see \`${FINDINGS_FILE}\` in the run artifact._`;
  for (const insert of [block, pointer]) {
    const out = insertBeforeFold(summary, insert);
    if (out.length <= limit) return out;
  }
  return summary;
}

function insertBeforeFold(summary: string, insert: string): string {
  let at = summary.lastIndexOf(REVIEW_DETAILS_FOLD);
  if (at < 0) {
    const markerAt = summary.lastIndexOf("<!-- ai-review kind=summary");
    at = markerAt < 0 ? summary.length : markerAt;
  }
  const before = summary.slice(0, at).replace(/\n*$/, "");
  const after = summary.slice(at);
  return after ? `${before}\n\n${insert}\n\n${after}` : `${before}\n\n${insert}`;
}

/**
 * Renders a review and writes both artifacts: the markdown preview a human
 * reads, and the exact GitHub API payloads, computed and not sent.
 *
 * Shared by a live run and by `rerender.ts`, so a formatting change can be
 * checked against every stored run without paying for a review.
 */
export async function writeArtifacts(o: {
  dir: string;
  tag: string;
  slug: string;
  /** Absent for a commit-range review: no pull request, so no payloads. */
  pr?: string | undefined;
  base: string;
  head: string;
  findings: Finding[];
  intentAlignment?: { summary?: string | undefined; unstated?: string[] | undefined; missing?: string[] | undefined } | undefined;
  dropped?: { title: string; reason: string }[] | undefined;
  stats: Record<string, unknown>;
  walkthrough?: Walkthrough | undefined;
  prior?: PriorComment[] | undefined;
  resolved?: { id: number; note?: string | undefined }[] | undefined;
  runs?: number | undefined;
  /** See `renderReview`. */
  noReviewers?: boolean | undefined;
  unreviewed?: { overCap: string[]; failed: string[]; budget?: string[] } | undefined;
  checked?: string[] | undefined;
  overCap?: Finding[] | undefined;
  /**
   * A checkout holding both `base` and `head`, used to read the diff and decide
   * where each comment may land. Omitting it, or a git failure, falls back to
   * trusting the model's own line — the behaviour before anchoring existed.
   */
  repoDir?: string | undefined;
  /**
   * The review is read on this machine and never posted: the markdown drops
   * the comment headings, the markers and the replies to GitHub threads, and
   * no payload file is written even for a pull request.
   */
  local?: boolean | undefined;
}) {
  let findings = o.findings;
  // Every file the change touches, which is not the same set as the files the
  // findings name — a surface that produced no finding still decides how the
  // rest are routed. Empty when the diff could not be read; `renderReview` falls
  // back to the findings' own files.
  let changedFiles: string[] = [];
  if (o.repoDir) {
    findings = await withOriginalText(o.repoDir, o.head, findings);
    try {
      const hunks = await loadHunks(o.repoDir, o.base, o.head);
      changedFiles = [...hunks.keys()];
      findings = findings.map((f) => ({
        ...f,
        _anchor: anchorFor(hunks, f.file, f.line, f.end_line),
      }));
      const off = findings.filter((f) => f._anchor?.kind !== "anchorable");
      for (const f of off) {
        console.error(
          `  anchor: ${f.file}:${f.line} is ${f._anchor?.kind}` +
            (f._anchor?.line ? ` → line ${f._anchor.line}` : " → summary comment"),
        );
      }
    } catch (err) {
      console.warn(`  could not read diff for anchoring, using model line numbers: ${err}`);
    }
  }

  const detailFile = `${o.tag}.detail.md`;
  const { summary, detail, inline, ordered, replies } = renderReview({
    pr: o.pr,
    detailFile,
    detailPath: path.join(o.dir, detailFile),
    head: o.head,
    findings,
    intentAlignment: o.intentAlignment,
    dropped: o.dropped,
    stats: o.stats,
    walkthrough: o.walkthrough,
    repo: o.slug,
    prior: o.prior,
    resolved: o.resolved,
    runs: o.runs,
    noReviewers: o.noReviewers,
    unreviewed: o.unreviewed,
    checked: o.checked,
    overCap: o.overCap,
    changedFiles,
    inlineMode: INLINE_MODE,
  });

  const md = o.local
    ? stripMarkers(
        [
          summary,
          ...(inline.length ? ["", "## Line comments", "", ...inline.flatMap((body) => [body, "", "---", ""])] : []),
        ].join("\n"),
      ) + "\n"
    : [
    "# Summary comment",
    "",
    summary,
    "",
    "---",
    "",
    "# Inline comments",
    "",
    // Each body already opens with its own title and location line, so the
    // preview adds only a separator. The marker is an HTML comment: invisible
    // when rendered, but present if the raw text is copied comment by comment.
    ...ordered.map((f, i) =>
      [
        `<!-- inline ${i + 1} of ${ordered.length} — ${f.file}:${f.line}${
          f._anchor && f._anchor.line !== f.line ? ` (anchored at line ${f._anchor.line})` : ""
        } -->`,
        "",
        inline[i],
        "",
        "---",
        "",
      ].join("\n"),
    ),
    ...(replies.length
      ? [
          "# Replies to existing review comments",
          "",
          ...replies.map((r, i) =>
            [
              `<!-- reply ${i + 1} of ${replies.length} — to ${r.author ? `@${r.author}` : "comment"} ${r.comment_id}${r.finding ? ` on ${r.finding.file}:${r.finding.line}` : " — closing it out as fixed"} -->`,
              "",
              ...(r.url ? [`In reply to ${r.url}`, ""] : []),
              r.body,
              "",
              "---",
              "",
            ].join("\n"),
          ),
        ]
      : []),
  ].join("\n");
  await writeText(path.join(o.dir, `${o.tag}.md`), md);
  // Written beside the preview so the artifact upload picks it up without the
  // workflow naming another path. Unlike the preview, this one is linked from
  // the posted comment and is meant to be read on its own.
  await writeText(path.join(o.dir, detailFile), o.local ? `${stripMarkers(detail)}\n` : detail);

  // No pull request means there is nowhere for these to go. Writing them anyway
  // would leave a file that looks sendable but names a pull request that has
  // nothing to do with this range — `post.ts` reads the endpoint out of the
  // file, so a wrong number there posts a review onto an unrelated PR.
  if (!o.pr || o.local) {
    // A payload file left over from an earlier run under this tag is worse than
    // no file: `post.ts` would happily send it.
    await removeIfPresent(path.join(o.dir, `${o.tag}.payloads.json`));
    if (!o.local) console.error("  local review: no pull request, so no API payloads written");
    return { summary, inline, ordered };
  }

  const payloads = {
    summary: {
      method: "POST",
      endpoint: `repos/${o.slug}/issues/${o.pr}/comments`,
      body: { body: summary },
    },
    review: {
      method: "POST",
      endpoint: `repos/${o.slug}/pulls/${o.pr}/reviews`,
      body: {
        commit_id: o.head,
        event: "COMMENT",
        // The anchor, not the model's line. They differ when a finding sits
        // just outside a hunk: GitHub refuses the whole review over one such
        // comment, so the comment moves to the nearest changed line and its
        // body says where the code really is.
        comments: ordered.map((f, i) => {
          const a = f._anchor;
          // Without an anchor — no checkout, or git failed — the model's own
          // numbers are used as-is, so they get the same ordering guarantee
          // `anchorFor` applies. `start_line > line` is a 422, and a 422 throws
          // away every comment in the review, not just this one.
          const first = f.end_line !== undefined ? Math.min(f.line, f.end_line) : f.line;
          const last = f.end_line !== undefined ? Math.max(f.line, f.end_line) : f.line;
          const span = last !== first;
          return {
            path: f.file,
            line: a?.line ?? last,
            ...(a
              ? a.start_line !== undefined
                ? { start_line: a.start_line }
                : {}
              : span
                ? { start_line: first }
                : {}),
            side: "RIGHT",
            body: inline[i],
          };
        }),
      },
    },
    // Acknowledgments land inside the thread that raised the point, so they do
    // not open a second thread on a line a human has already commented on.
    replies: replies.map((r) => ({
      method: "POST",
      endpoint: `repos/${o.slug}/pulls/${o.pr}/comments/${r.comment_id}/replies`,
      body: { body: r.body },
    })),
  };
  await writeJson(path.join(o.dir, `${o.tag}.payloads.json`), payloads);

  return { summary, inline, ordered };
}
