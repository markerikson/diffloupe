import { describeLink, type CodeGroup, type Link } from "./lib/grouping.ts";
import { repoName } from "./config.ts";
import { type Finding } from "./findings.ts";
import { MAX_POSTED } from "./coordinate.ts";

// ---------------------------------------------------------------- prompts

export const QUESTION_AFFORDANCE = `
Calibrated uncertainty — this matters as much as finding bugs:
- If you notice a discrepancy that you investigated and could argue either way, do NOT silently drop it. Report it with severity "question" and state both sides: what looks inconsistent, and the evidence that suggests it may be intentional. The author knows the intent and can answer in one word; you cannot.
- This applies especially when a change is added to one of several parallel lists, registries, or spec files and not the others, and the existing entries are themselves inconsistent. Inconsistent precedent is not proof that the omission is correct.
- Use "question" only where you have concrete evidence of the discrepancy and cite both the place it was added and the places it was not. Do not use it to hedge vague concerns.
`.trim();

export const REVIEW_CORE = `
Your goal is to find real problems a reviewer would want to know about before merging: logic errors, race conditions, unhandled edge cases, resource leaks, violated invariants, and architectural problems (code in the wrong layer, a concept duplicated instead of reused, a design that will not survive the next change).

Scope and priorities:
- Correctness first, and production impact above all. A bug that reaches users or corrupts data outranks everything else.
- Weigh where the code runs. Shipped product code matters most. Deployment and infrastructure config can take production down. Developer tooling, build scripts and test harnesses cost one engineer time, not users — hold them to a higher bar: report them when they are broken, not when they are untidy.
- Architecture second. Say so if the change is in the wrong place or duplicates something that already exists.
- Nothing else. Do not comment on formatting, naming, import order, code style, or test coverage. Linters, formatters and the typechecker already cover all of it, and anything the typechecker catches is not your job.

Reducing noise:
- Do not report an issue you cannot point at. If you cannot cite a specific file and line, do not make the claim.
- Before asserting a bug, go read the code that would disprove it: the guard clause elsewhere, the existing helper, the sibling registration, the caller that already handles the case.
- Do not restate what the diff does. Do not praise. Do not suggest adding comments.
- Report nothing rather than padding with weak findings.
`.trim();

export function slicePrompt(o: {
  unit: ReviewUnit;
  diff: string;
  intent: { title: string; body: string; commits: string };
  registry: string;
  prior: string;
  mapNote: string;
  outFile: string;
  crossLinks?: string[];
}) {
  const files = o.unit.files.map((f) => `\`${f}\``).join(", ");
  const cross = o.crossLinks?.length
    ? `\n\nThese changed files are linked to files that another reviewer has. That reviewer is checking the other side, so check the contract from yours — that each name used here matches what the other file now defines, and each definition here suits how the other file uses it:\n${o.crossLinks.map((l) => `- ${l}`).join("\n")}`
    : "";
  return `You are reviewing one coherent part of a pull request in the ${repoName} repository.

${REVIEW_CORE}

${QUESTION_AFFORDANCE}

This is ONE SLICE of a larger pull request: **${o.unit.title}**. ${o.unit.rationale ?? ""}

Review the changes in these files, which were grouped together because they implement one thing: ${files}. Because they belong to one flow, look hard at how they fit together — a value written in one file and read in another, a name or key that must match across files, an ordering assumption between them. Cross-file inconsistency inside this group is exactly what you are best placed to catch, and no other reviewer is looking at this combination.

Other changed files in this pull request are being reviewed separately; do not comment on them. Because you see only part of the change, it is your job to establish the surrounding context yourself by reading the repository.${cross}

## Pull request intent (as stated by the author)
Title: ${o.intent.title}

${o.intent.body?.slice(0, 4000) || "(no description)"}

Commit messages:
${o.intent.commits.slice(0, 3000) || "(none)"}

${o.mapNote}${o.registry ? `\n${o.registry}\n` : ""}${o.prior ? `\n${o.prior}\n` : ""}
## Diff for this slice
\`\`\`diff
${o.diff}
\`\`\`

Write your findings as JSON to \`${o.outFile}\`. Write the file even if you have no findings (use an empty array).`;
}

export function mergePrompt(o: {
  findings: Finding[];
  intent: { title: string; body: string; commits: string };
  files: string[];
  prior: string;
  outFile: string;
}) {
  return `You are the coordinator for a code review of a pull request in ${repoName}. Independent reviewers each looked at one changed file. Your job is to turn their raw findings into the review that actually gets posted.

## Changed files
${o.files.map((f) => `- ${f}`).join("\n")}

## Pull request intent (as stated by the author)
Title: ${o.intent.title}

${o.intent.body?.slice(0, 4000) || "(no description)"}

Commit messages:
${o.intent.commits.slice(0, 3000) || "(none)"}
${o.prior ? `\n${o.prior}\n` : ""}
## Raw findings from the per-file reviewers
Each carries an \`id\`. You will refer to them by that id; you never retype their text.
The \`id\` is assigned here and overwrites anything a reviewer wrote, so it is always the
position in this list.
\`\`\`json
${JSON.stringify(o.findings.map((f, i) => ({ ...f, id: i })), null, 2)}
\`\`\`

Do all of the following:

1. **Verify before keeping.** For each finding, open the cited file and line and confirm the code says what the finding claims. Drop any finding whose cited symbol, function, or line does not exist, or whose claim the surrounding code contradicts. This is the single most important thing you do — a confident wrong comment costs more than a missed bug.

2. **Deduplicate.** Several reviewers may report the same underlying problem from different files. Keep the one located at the best place to fix it and name the others in its \`merge_with\`; their locations get folded into its cross-file references automatically.

3. **Drop noise.** Remove anything about formatting, naming, style, import order, or test coverage. Remove anything a typechecker or linter would catch. Remove anything about comments themselves — a stale, empty, or missing comment is never a finding. Remove findings that only restate what the diff does. Remove speculative findings that require an unlikely precondition to matter.

4. **Reconcile with what has already been said.** If a finding makes the same claim as a comment in the "comments already on this pull request" section, keep it and set \`repeat_of\` to that comment's id — do not drop it. Corroborating a human reviewer has value on its own, and these are shown separately from the new findings, so they cost the reader nothing. Drop it only if the current code shows the comment has already been addressed.

   The test for \`repeat_of\` is whether the two are the same claim, not whether they are about the same code. Same file, same function, same line, even the same variable is not enough. Ask what each one says is wrong: if fixing what the comment asks for would leave the finding's problem still there, they are different claims and the finding is new. A comment asking to rename a parameter and a finding that the same function drops an error are unrelated. Getting this wrong costs a real bug — a finding filed as \`repeat_of\` is not posted where it belongs, it is demoted into someone else's thread as agreement. When you are unsure, leave \`repeat_of\` off and let it stand on its own.

   \`repeat_of\` points only at a human's comment. Never point it at one of your own comments from the "what you already told this author" section; you cannot corroborate yourself. Anything you already said is either dropped or reported fresh as a new development, per the instructions in that section.

5. **Close out what you fixed.** For each comment in the "what you already told this author" section, open the code it points at. If the current code no longer has the problem, put its id in \`resolved\` with one sentence naming what changed. Say nothing about it anywhere else. A point that quietly disappears reads as you losing track of it; saying it is fixed ends the thread and stops any later review from raising it again. Only put a comment in \`resolved\` when you have read the code and it is genuinely fixed — never to clear out a point you merely no longer believe.

6. **Judge intent alignment.** Compare what the author said this PR does against what the diff actually does. Report only substantive divergences: behavior changed that the description does not mention, a stated goal the diff does not accomplish, or scope that looks unrelated to the stated purpose. Say nothing if it lines up.

7. **Cap.** Keep at most ${MAX_POSTED} new findings. Anything carrying \`repeat_of\` is shown in a separate section and does not count against that limit. Production impact decides what survives the cut: a finding in shipped \`src/\` code or in deployment config outranks one in \`scripts/\` or a test harness at the same severity. Keep a tooling finding only when the tooling is actually broken — sloppiness there is not worth a comment. Cut low-confidence and nice-to-have items first. Sorting is handled for you. A finding that is sound but did not make the cut goes in \`drop\` with the reason \`cap\` and nothing else; those are listed separately for the author, so do not use \`cap\` for anything you rejected on its merits.

Your output is a set of decisions, not a rewritten review. The reviewers' own wording is kept verbatim, so do not restate it — every finding you keep must be listed by number, and every finding you do not keep must appear in \`drop\` with a reason. Correct a finding only through \`severity\`, which overrides theirs, or \`note\`, one sentence appended to their explanation when they got the reasoning slightly wrong but the finding stands.

Write a single JSON object to \`${o.outFile}\`:
\`\`\`json
{
  "keep": [ { "id": 0, "severity": "blocker|should-fix|question|nice-to-have",
              "merge_with": [3, 7], "repeat_of": 123456, "note": "" } ],
  "drop": [ { "id": 1, "reason": "why it did not survive verification" } ],
  "resolved": [ { "id": 987654, "note": "the null check was added in this push" } ],
  "intent_alignment": {
    "summary": "one sentence, or empty string if the diff matches the description",
    "unstated": ["behavior present in the diff that the description does not mention"],
    "missing": ["stated goals the diff does not accomplish"]
  }
}
\`\`\`
\`severity\`, \`merge_with\`, \`repeat_of\` and \`note\` are all optional, and \`resolved\` is an empty array when nothing you previously raised has been fixed. Ids in \`resolved\` are comment ids from the "what you already told this author" section, not finding numbers. Write the file even if \`keep\` is empty.`;
}

export interface ReviewUnit {
  id: string;
  title: string;
  rationale?: string;
  files: string[];
  priority?: number;
}

/**
 * Turns the planner's proposed grouping into one that actually covers the diff.
 *
 * The grouping is a suggestion; coverage is not. A file the planner dropped
 * would never be reviewed and nothing downstream would report its absence, so
 * every correction is made here rather than asked for in the prompt.
 *
 * Four corrections, in order. A path the planner invented is removed, because a
 * unit naming a file that does not exist sends a reviewer looking for it. A file
 * placed in two units is kept in the first, because reviewing it twice pays for
 * two slices and produces two copies of the same finding for the coordinator to
 * merge back together. A unit left with no files is dropped rather than run
 * empty. Whatever is still unassigned is swept into one unit of its own.
 *
 * That last correction is also what makes a total planner failure survivable:
 * given nothing usable it sweeps every file into a single unit, which reviews
 * the whole diff at once. That is much worse than a flow-grouped review and much
 * better than none. It is why there is no separate fallback here — the only way
 * this returns an empty list is being handed no files, and the caller returns
 * before that, since a diff with no code in it has nothing to review.
 */
export function coverUnits(proposed: ReviewUnit[], sliceFiles: string[]): ReviewUnit[] {
  const seenFile = new Set<string>();
  const units: ReviewUnit[] = [];
  for (const u of proposed) {
    const files = (u.files ?? []).filter((f) => sliceFiles.includes(f) && !seenFile.has(f));
    for (const f of files) seenFile.add(f);
    if (files.length) units.push({ ...u, files });
  }
  const orphans = sliceFiles.filter((f) => !seenFile.has(f));
  if (orphans.length) {
    units.push({
      id: "unassigned",
      title: "Remaining changes",
      rationale: "These files were not grouped with any flow; review them on their own terms.",
      files: orphans,
      priority: 9,
    });
  }
  return units;
}

/**
 * One reviewer's share of a unit. `unitId` is the semantic unit it came from,
 * which is what findings are attributed to and what the walkthrough builds its
 * chapters from — splitting is a budgeting decision and is not meant to be
 * visible in the output.
 */
export interface ReviewSlice {
  unitId: string;
  /** Unit title, carrying a part suffix only when the unit was split. */
  title: string;
  rationale?: string;
  files: string[];
  priority?: number;
  part: number;
  parts: number;
  tokens: number;
}

/**
 * Cuts each unit into shares no larger than `budget` tokens of diff.
 *
 * The planner groups by meaning, which is the right unit for a human reading
 * the review and the wrong unit for an agent's context window: on one pull
 * request it produced a coherent 12-file unit that was also 138k tokens of
 * diff, and the reviewer given it spent its budget re-reading rather than
 * investigating. Meaning and size are separate concerns, so they are decided
 * separately — the unit stays whole in the output, and only the reviewer sees
 * the split.
 *
 * First-fit-decreasing, largest file first, which keeps bins full and is stable
 * across runs given the same diff. A file larger than the budget gets a bin to
 * itself rather than being cut: slices are addressed by file path, so there is
 * no way to hand a reviewer part of a file today. Such a bin is over budget by
 * construction and nothing else joins it, because every later file fails the
 * fit test against it.
 */
export function packUnits(
  units: ReviewUnit[],
  fileTokens: Map<string, number>,
  budget: number,
): ReviewSlice[] {
  const out: ReviewSlice[] = [];
  for (const u of units) {
    const bySize = [...u.files].sort(
      (a, b) => (fileTokens.get(b) ?? 0) - (fileTokens.get(a) ?? 0) || a.localeCompare(b),
    );
    const bins: { files: string[]; tokens: number }[] = [];
    for (const f of bySize) {
      const t = fileTokens.get(f) ?? 0;
      const bin = bins.find((b) => b.tokens + t <= budget);
      if (bin) {
        bin.files.push(f);
        bin.tokens += t;
      } else {
        bins.push({ files: [f], tokens: t });
      }
    }
    bins.forEach((b, i) => {
      out.push({
        unitId: u.id,
        title: bins.length > 1 ? `${u.title} (part ${i + 1} of ${bins.length})` : u.title,
        rationale: u.rationale,
        priority: u.priority,
        // Back to path order: the bin was filled largest-first, but a reviewer
        // reads the list.
        files: [...b.files].sort(),
        part: i + 1,
        parts: bins.length,
        tokens: b.tokens,
      });
    });
  }
  return out;
}

export interface Walkthrough {
  review_units?: ReviewUnit[];
  focus?: string;
  change_type?: string;
  start_here?: { file: string; why: string }[];
  chapters?: {
    title: string;
    icon?: string;
    blurb?: string;
    stops?: {
      title: string;
      importance?: "critical" | "normal" | "context";
      prose?: string;
      locations?: { file: string; line?: number; label?: string }[];
    }[];
  }[];
  support?: { files: string[]; reason: string }[];
  intent?: {
    inferred?: string;
    alignment?: "aligned" | "partial" | "misaligned";
    matches?: string[];
    mismatches?: string[];
    unstated?: string[];
    missing?: string[];
  };
}

/**
 * Orientation pass. Sees the whole diff at shallow depth, unlike the slices,
 * which see one file deeply. Structure follows codiff's narrative walkthrough:
 * chapters are conceptual groups rather than files, and a stop is one review
 * idea that may span files.
 */
/**
 * Partition only. This is the one model call on the critical path before any
 * review starts, so it is kept deliberately cheap and told not to explore:
 * grouping files by mechanism needs the diff, not the repository.
 */
export function partitionPrompt(o: {
  diffstat: string;
  outline: string;
  intent: { title: string; body: string; commits: string };
  codeFiles: string[];
  registry: string;
  outFile: string;
}) {
  return `You are planning how to split up the review of a pull request in ${repoName}. You are not reviewing anything and you are not looking for bugs. You are deciding which changed files each reviewer should see together.

Work from the outline below. **Do not read files from the repository** — you do not need them for this decision, and the reviewers who follow you will do that work.

## Stated intent
Title: ${o.intent.title}

${o.intent.body?.slice(0, 2000) || "(no description)"}

## Files changed
${o.diffstat}

## Files to partition — each must appear in exactly one unit
${o.codeFiles.map((f) => `- ${f}`).join("\n")}
${o.registry ? `\n${o.registry}\n` : ""}
## Where the change lands
Each line is one hunk: the file it sits in, and the function or class enclosing it.
\`\`\`diff
${o.outline}
\`\`\`

Partition the listed files into 1-6 review units. A unit is a *flow*, not a directory and not a file: the files that participate in one mechanism, so that a reviewer holding all of them at once can see a value written in one file and read in another, a key or name that must match across files, or an ordering assumption between them. Files that have to agree with each other belong in the same unit — that is the entire point of grouping. Split units when the mechanisms are genuinely independent, because a reviewer given unrelated files divides attention badly. A single-file unit is correct when that file stands alone.

Put the unit where the risk concentrates at \`priority\` 1.

Two things constrain the size. The units are reviewed **at the same time, in parallel**, so one oversized unit becomes the bottleneck for the whole review while the other reviewers sit idle — keep them roughly comparable in diff size. And a reviewer given more than about five files reads each of them less carefully. When a large group shares one mechanism but splits cleanly into layers that are checked differently — the cloud resources that define an identity, the chart that consumes it, the pipeline that deploys it — make them separate units and say in each \`rationale\` which names it must agree with, so each reviewer knows what to go look up.

Write only this JSON to \`${o.outFile}\`:
\`\`\`json
{ "review_units": [ { "id": "short-slug", "title": "a few words naming the mechanism, not the paths",
  "rationale": "one sentence the reviewer will read as their brief: what this group does and what would break",
  "files": ["..."], "priority": 1 } ] }
\`\`\``;
}

/**
 * Names groups computed from the diff. The grouping itself is decided in code;
 * the model writes the brief each reviewer reads, ranks the groups by risk, and
 * may move a file the links missed. Moves are checked before they are applied
 * (`applyGroupNaming`), so a bad answer costs a title, not coverage.
 */
export function groupNamingPrompt(o: {
  groups: CodeGroup[];
  links: Link[];
  outline: string;
  intent: { title: string; body: string; commits: string };
  registry: string;
  outFile: string;
}) {
  const inGroup = new Map(o.groups.flatMap((g) => g.files.map((f) => [f, g.id] as const)));
  const blocks = o.groups.map((g) => {
    const inside = g.links.filter((l) => l.kind !== "dir").slice(0, 6).map((l) => `  - ${describeLink(l)}`);
    return [
      `### ${g.id} (${g.tokens} diff tokens)`,
      ...g.files.map((f) => `- ${f}`),
      ...(inside.length ? ["Linked by:", ...inside] : []),
    ].join("\n");
  });
  const cut = o.links
    .filter((l) => l.kind !== "dir" && inGroup.get(l.from) !== inGroup.get(l.to))
    .slice(0, 20)
    .map((l) => `- ${describeLink(l)} (${inGroup.get(l.from)} → ${inGroup.get(l.to)})`);
  return `You are preparing the review of a pull request in ${repoName}. The changed files have already been grouped, from links found in the diff: a name used on added lines of one file and defined on added lines of another, a test and the file it tests, an import. Each group goes to its own reviewer, in parallel. You are not reviewing anything and you are not looking for bugs.

Work from what is below. **Do not read files from the repository.**

## Stated intent
Title: ${o.intent.title}

${o.intent.body?.slice(0, 2000) || "(no description)"}
${o.registry ? `\n${o.registry}\n` : ""}
## Groups
${blocks.join("\n\n")}

## Links between groups
${cut.length ? cut.join("\n") : "(none)"}

## Where the change lands
Each line is one hunk: the file it sits in, and the function or class enclosing it.
\`\`\`diff
${o.outline}
\`\`\`

For every group, write:
- \`title\`: a few words naming the mechanism, not the paths.
- \`rationale\`: one sentence the reviewer reads as their brief — what this group does and what would break. When a link to another group matters, name it.
- \`priority\`: 1 for the group where the risk concentrates, larger numbers for less.

You may also move a file to another group, but only when it plainly belongs with that group's mechanism and the links above missed it — for example, a config entry read only by code in another group. Leave the grouping alone otherwise. Moves that would make a group too large are ignored.

Write only this JSON to \`${o.outFile}\`:
\`\`\`json
{ "groups": [ { "id": "group id from above", "title": "...", "rationale": "...", "priority": 1 } ],
  "moves": [ { "file": "path", "to": "group id", "reason": "one sentence" } ] }
\`\`\``;
}

/**
 * Render a file list as one line per directory. The walkthrough's output is the
 * scarce resource, not its input: asking it to account for every changed file
 * made the demanded output scale with the file count, and on a 161-file PR that
 * ran the model into its own output ceiling twice over. Presenting the input
 * grouped is half the remedy — a model shown a per-file list writes a per-file
 * list back. The other half is telling it directories are an acceptable answer.
 */
export function groupByDir(files: string[]): string {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const i = f.lastIndexOf("/");
    // Trailing slash always, including at the repo root: the prompt tells the
    // model a directory entry ends in one, and a bare "." reads as a filename.
    const dir = i === -1 ? "./" : f.slice(0, i + 1);
    const group = byDir.get(dir);
    if (group) group.push(f);
    else byDir.set(dir, [f]);
  }
  return [...byDir]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([dir, fs]) =>
      // One file under a directory is cheaper and clearer named outright than
      // described as a group of one.
      fs.length === 1 ? `- ${fs[0]}` : `- ${dir} (${fs.length} files)`,
    )
    .join("\n");
}

export function walkthroughPrompt(o: {
  diffstat: string;
  diff: string;
  intent: { title: string; body: string; commits: string };
  findingIndex: string;
  unitSummary: string;
  crossLinks: string[];
  docsFiles: string[];
  /** One sketch line per changed file whose diff is not shown. */
  sketches: string[];
  registry: string;
  outFile: string;
}) {
  return `You are writing the reviewer's guide for a pull request in ${repoName}: what the change actually does, and the order a human should read it in. You are NOT looking for bugs — specialist reviewers have already done that, and their findings are listed below to tell you where the risk turned out to be.

## Stated description (what the author says it does)
Title: ${o.intent.title}

${o.intent.body?.slice(0, 4000) || "(no description)"}

Commit messages:
${o.intent.commits.slice(0, 3000) || "(none)"}

## Files changed
${o.diffstat}

## How the review was split up
Files were grouped by how the code links them: a name used in one file and added in another, an import, a test beside its source. A group's links are the order its files are read in.

${o.unitSummary}
${o.crossLinks.length ? `\n### Links between groups\nThese cross from one group to another. A stop that follows one of them can name locations in both groups.\n${o.crossLinks.map((l) => `- ${l}`).join("\n")}\n` : ""}
## What the reviewers found
${o.findingIndex || "(nothing)"}

${o.docsFiles.length ? `## Documentation-only files (already excluded from review; cover them with one \`support\` group)\n${groupByDir(o.docsFiles)}\n` : ""}${o.registry ? `\n${o.registry}\n` : ""}
## Diff
\`\`\`diff
${o.diff}
\`\`\`
${
  o.sketches.length
    ? `
## Changed files whose diff is not shown above (${o.sketches.length})
The diff was too large to include whole, so the budget was shared across the groups and these files are given as sketches instead: lines added and removed, the names each one adds, and the functions its edits fall in, with the first changed line as \`name@line\`. You have not read their code. A stop may name one of these files when its sketch, the group it belongs to, or the findings above say enough to explain why it matters; use a \`name@line\` from its sketch as the location. Cover the rest with \`support\` groups, naming directories rather than files.
${o.sketches.join("\n")}
`
    : ""
}
Produce two things.
**1. Inferred intent.** Read the diff and state what it actually does, independently of the description. Then compare the two. \`alignment\` is "aligned" if the diff does what the description says and nothing surprising beyond it, "partial" if it does the stated work plus unstated behavior changes or omits part of what was promised, "misaligned" if the diff's actual effect differs from the description. \`inferred\` is two to four sentences describing the change as you understand it from the code alone — write it for someone who has not read the description. \`matches\`, \`mismatches\`, \`unstated\` and \`missing\` are short bullet strings; leave them empty rather than padding.

**2. A guided walkthrough.**
- \`start_here\`: the 2-4 files a reviewer should open first, each with a one-line reason. Order matters. Pick the files where understanding the change begins or where the risk concentrates — not the largest files.
- \`chapters\`: 1-6 conceptual groups in reading order. A chapter is an idea, not a file. \`title\` is 1-2 words, at most 16 characters ("Runtime", "CLI", "Tests", "Cleanup"). \`icon\` is one of bug, wrench, path, flask, doc, gear. \`blurb\` is one sentence.
- \`chapters[].stops\`: one review *idea* per stop. \`title\` is 2-6 words, semantic and never a filename — "Prevent duplicate payments", not "update payments.ts". \`prose\` is 1-3 sentences on why this stop matters and what to check. \`importance\` is "critical" if a reviewer must understand it, "normal" for the main path, "context" for supporting detail. \`locations\` are the file/line pairs to read for this stop, cross-file allowed, in reading order. Total stops across all chapters: 1-3 for a small change, 5-9 for a medium one, 7-12 for a large one. Never exceed 14.
- \`support\`: changed files deliberately kept off the main path — generated output, lockfiles, snapshots, mechanical repeats, anything you did not read — grouped with a reason. A reviewer should be able to skip everything here. **At most 8 groups.** An entry in \`files\` may be a directory path ending in \`/\`, which means every changed file under it that no stop names; prefer that to listing files. Name a file outright only when it is alone in its directory or the reason applies to it and not its neighbours.

Account for every changed file: each one should be reachable either from a stop or from a \`support\` entry, where a directory entry covers everything beneath it. Do not enumerate files to prove coverage — a directory that covers forty files is a better answer than forty filenames, and the guide is read by a human who will not read a list that long. Do not invent files, directories, or lines.

Write a single JSON object to \`${o.outFile}\`:
\`\`\`json
{
  "focus": "one or two sentences on what reviewing this change is really about",
  "change_type": "fix|feature|refactor|test|docs|mixed",
  "intent": { "inferred": "...", "alignment": "aligned|partial|misaligned",
              "matches": [], "mismatches": [], "unstated": [], "missing": [] },
  "start_here": [ { "file": "...", "why": "..." } ],
  "chapters": [ { "title": "Runtime", "icon": "bug", "blurb": "...",
    "stops": [ { "title": "...", "importance": "critical", "prose": "...",
                 "locations": [ { "file": "...", "line": 123, "label": "..." } ] } ] } ],
  "support": [ { "files": ["path/to/dir/", "standalone-file.ts"], "reason": "..." } ]
}
\`\`\`

Write the object once, in one \`write\` call, and nothing else. Everything above bounds it: at most 14 stops, at most 8 support groups, prose of 1-3 sentences. A guide that runs past those limits is a worse guide, not a more thorough one, and one long enough to exhaust your output budget is not delivered at all.`;
}
