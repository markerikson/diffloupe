/**
 * Where a review comment is allowed to land.
 *
 * `POST /pulls/{n}/reviews` rejects the entire review — every comment in it —
 * if any one comment names a line that is not part of the diff. Two of the
 * nine findings in the two most recent stored runs would have done that:
 * `scripts/tool/index.ts:32` on a file the PR does not touch at all, and
 * `src/shared/Utils.h:417` one line above the `418-425` hunk.
 * The second is worse than it looks, because that finding spans 417-435 and a
 * multi-line comment needs both ends inside the diff.
 *
 * Neither finding is wrong. The `investigate-mcp` one is the best thing the
 * pipeline has produced — a stale exec path no human caught — and it is
 * valuable precisely because it is outside the diff. So the rule is not to
 * drop them: reachable ones move to the nearest changed line, unreachable ones
 * move into the summary comment with a permalink.
 */
import { text } from "./proc.ts";

export interface Range {
  start: number;
  end: number;
}

export type AnchorKind = "anchorable" | "off-hunk" | "off-diff";

export interface Anchor {
  kind: AnchorKind;
  /** RIGHT-side line to attach the comment to. Absent for `off-diff`. */
  line?: number;
  /** Present only for a span that fits entirely inside the diff. */
  start_line?: number;
}

export type HunkMap = Map<string, Range[]>;

/**
 * Added-line ranges per file, on the right-hand side of the diff.
 *
 * Parses `git diff --unified=0`, which reports each changed region separately
 * instead of merging neighbours behind three lines of context. A wider context
 * would report lines GitHub will still refuse.
 *
 * Deletions are skipped: a `@@ -a,b +c,0 @@` hunk removes lines and adds none,
 * so it has no right-hand line to comment on, and every comment this pipeline
 * writes is `side: "RIGHT"`. Binary files (20 are marked so in `.gitattributes`)
 * produce no hunks and so end up with an empty range list, which reads the same
 * as "nothing here can be anchored".
 */
export async function loadHunks(repoDir: string, base: string, head: string): Promise<HunkMap> {
  return parseDiffHunks(await text("git", ["-C", repoDir, "diff", "--unified=0", `${base}..${head}`]));
}

/**
 * Walks `git diff` output, reporting which file each line belongs to.
 *
 * Telling a header from content is harder than it looks, and getting it wrong is
 * silent: at zero context every non-header line is content, a deleted line
 * reading `-- x` arrives as `--- x`, and an added `++ y` arrives as `+++ y`. The
 * additions in a hunk follow the deletions immediately, so the two together read
 * exactly like a file header, and every hunk after that point is filed under a
 * path that does not exist.
 *
 * The discriminator is the hunk header's own line counts. `@@ -a,b +c,d @@` says
 * the body holds b lines on the old side and d on the new, so counting them down
 * gives the exact point where the body ends and headers become possible again.
 * Nothing inside a body is ever read as a header. Recognising the end of a file
 * by its `diff --git` line instead would work on git's own output and fail on a
 * patch produced by anything else.
 *
 * `b/` is stripped rather than required: `diff.noprefix` in a developer's git
 * config omits it, and a parser that insists on it silently finds no files at
 * all under that setting.
 *
 * Shared so that the two passes over a diff — anchoring here and the identifier
 * scan in `build-map.ts` — cannot drift into disagreeing about the format.
 */
export function* diffLines(out: string): Generator<{ file?: string | undefined; line: string }> {
  let file: string | undefined;
  let sawOldHeader = false;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of out.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      // "\ No newline at end of file" annotates the line before it and is not
      // one of the lines the header counted.
      if (!line.startsWith("\\")) {
        if (line.startsWith("-")) oldLeft--;
        else if (line.startsWith("+")) newLeft--;
        else {
          oldLeft--;
          newLeft--;
        }
      }
      yield { file, line };
      continue;
    }
    if (line.startsWith("diff --git ")) {
      sawOldHeader = false;
      file = undefined;
      continue;
    }
    if (line.startsWith("--- ")) {
      sawOldHeader = true;
      continue;
    }
    if (sawOldHeader && line.startsWith("+++ ")) {
      sawOldHeader = false;
      const p = line.slice(4).trim();
      // `/dev/null` is a deleted file.
      file = p === "/dev/null" ? undefined : p.replace(/^b\//, "");
      yield { file, line };
      continue;
    }
    sawOldHeader = false;
    const counts = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (counts) {
      oldLeft = counts[1] === undefined ? 1 : Number(counts[1]);
      newLeft = counts[2] === undefined ? 1 : Number(counts[2]);
    }
    yield { file, line };
  }
}

/**
 * How many bytes of diff text each changed file accounts for.
 *
 * This exists because sizing needs the old-side path that `diffLines`
 * deliberately drops. A deleted file has no new-side lines to anchor a comment
 * to, so the anchoring walker reports it as `undefined`; but its diff is still
 * text a reviewer has to read, and a packer that sized every deletion at zero
 * would hand one reviewer an unbounded pile of them for free.
 *
 * Counting starts at the `---` header, so the four `diff --git`/`index` lines
 * per file are not attributed to anyone. That is a rounding error against a
 * budget in the tens of thousands of tokens, and charging them to the previous
 * file would be worse than dropping them.
 *
 * `a/` and `b/` are stripped rather than required, for the same reason as
 * `diffLines`: `diff.noprefix` in a developer's git config omits them.
 */
export function diffSizes(out: string): Map<string, number> {
  const sizes = new Map<string, number>();
  let file: string | undefined;
  let oldPath: string | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = undefined;
      oldPath = undefined;
    } else if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      oldPath = p === "/dev/null" ? undefined : p.replace(/^a\//, "");
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      // `+++ /dev/null` is a deletion: the old side is the only path there is.
      file = p === "/dev/null" ? oldPath : p.replace(/^b\//, "");
    }
    if (file) sizes.set(file, (sizes.get(file) ?? 0) + line.length + 1);
  }
  return sizes;
}

/** Deleted files at or under this many lines are shown whole. */
export const DELETED_FILE_LINES = 40;
const DELETED_DECL_LIMIT = 30;

/**
 * Top-level declarations in TypeScript, JavaScript and C++: unindented lines
 * that open a definition. Callers left behind by a deletion break on these
 * names, so they are what a reviewer needs from a removed file.
 */
const DECLARATION =
  /^(?:export\s|declare\s|async\s|function[\s*]|class\s|interface\s|type\s|enum\s|const\s|let\s|var\s|abstract\s|namespace\s|module\.exports|exports\.|struct\s|template\s*<|typedef\s|using\s|#define\s|[A-Za-z_][\w:<>,*&\s]*\s[*&]?[\w:~]+\()/;

/**
 * Shortens the diff of every deleted file longer than `DELETED_FILE_LINES` to
 * its top-level declarations plus a note saying how to read the rest.
 *
 * In #13157, deleted lines were 18% of the diff text. A reviewer cannot find a
 * bug in code that no longer exists; what it can find is a caller that still
 * uses a removed name, and for that the declarations are enough. The full text
 * stays one `git show` away in the reviewer's checkout.
 *
 * The rewritten hunk header counts the kept lines, so the result still parses
 * with `diffLines` and `diffSizes`; the note follows the hunk body, where the
 * parsers read it as a header line and ignore it.
 */
export function compactDeletedFiles(diff: string, base: string): string {
  const sections = diff.split(/^(?=diff --git )/m);
  return sections
    .map((section) => {
      if (!/^\+\+\+ \/dev\/null$/m.test(section)) return section;
      const lines = section.split("\n");
      const hunk = lines.findIndex((l) => l.startsWith("@@ "));
      if (hunk < 0) return section;
      const body = lines.slice(hunk + 1).filter((l) => l.startsWith("-"));
      if (body.length <= DELETED_FILE_LINES) return section;
      const oldPath = /^--- (?:a\/)?(.+)$/m.exec(section)?.[1] ?? "";
      const kept = body.filter((l) => DECLARATION.test(l.slice(1))).slice(0, DELETED_DECL_LIMIT);
      const trailing = section.endsWith("\n") ? "\n" : "";
      return [
        ...lines.slice(0, hunk),
        ...(kept.length ? [`@@ -1,${kept.length} +0,0 @@`, ...kept] : []),
        `# Deleted file, ${body.length} lines. Only its top-level declarations are shown; ` +
          `read the rest with \`git show ${base.slice(0, 12)}:${oldPath}\`.`,
      ].join("\n") + trailing;
    })
    .join("");
}

/** The parsing half of `loadHunks`, separated so it can be tested without a repo. */
export function parseDiffHunks(out: string): HunkMap {
  const map: HunkMap = new Map();

  for (const { file, line } of diffLines(out)) {
    if (file && !map.has(file)) map.set(file, []);
    if (!file || !line.startsWith("@@")) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count <= 0) continue;
    map.get(file)!.push({ start, end: start + count - 1 });
  }
  return map;
}

/**
 * How far a comment may be moved to reach a changed line.
 *
 * Measured over the ten stored runs: six findings landed outside a hunk, at
 * distances of 1, 49, 96, 114 and 194 lines. Only the 1-line case is a finding
 * about code next to the change; the rest are about code elsewhere in a file
 * the pull request happens to touch. Posting those on the nearest changed line
 * points the reader at unrelated code, so past this distance the finding goes
 * to the summary with a permalink instead — the same treatment as a file that
 * is not in the diff at all.
 */
export const SNAP_LIMIT = 20;

const within = (ranges: Range[], line: number) =>
  ranges.some((r) => line >= r.start && line <= r.end);

/** True when one changed region contains both ends of a span. */
const sameRange = (ranges: Range[], a: number, b: number) =>
  ranges.some((r) => a >= r.start && a <= r.end && b >= r.start && b <= r.end);

/** Distance from a line to the closest changed line, and that line. */
function nearest(ranges: Range[], line: number): { line: number; distance: number } | undefined {
  let best: { line: number; distance: number } | undefined;
  for (const r of ranges) {
    const snapped = line < r.start ? r.start : line > r.end ? r.end : line;
    const distance = Math.abs(snapped - line);
    if (!best || distance < best.distance) best = { line: snapped, distance };
  }
  return best;
}

/**
 * Decides where a finding's comment can go.
 *
 * A span is kept only when one changed region contains both of its ends.
 * Two ends in two different hunks means the span crosses unchanged lines that
 * are not in the diff, and GitHub is not documented to accept that; a review
 * that guesses wrong loses every comment in it, not just this one. A span that
 * does not qualify collapses to a single anchored line rather than being
 * thrown away — the body still states the true range.
 */
export function anchorFor(
  hunks: HunkMap,
  file: string,
  line: number,
  endLine?: number | null,
): Anchor {
  // JSON has no undefined: a model that means "no end line" writes null, and
  // nothing between JSON.parse and here normalizes it. `null !== undefined`
  // would carry it into the finiteness check below and send an otherwise
  // anchorable finding to the summary.
  const end = endLine ?? undefined;
  const ranges = hunks.get(file);
  if (!ranges || ranges.length === 0) return { kind: "off-diff" };

  // The model omitting `line`, or writing it as a string, makes every
  // comparison below false rather than throwing: the snap arithmetic yields NaN,
  // `NaN > SNAP_LIMIT` is false, and this returns an "anchored" line of NaN that
  // JSON.stringify writes as null. GitHub 422s that, and a 422 discards every
  // comment in the review. A finding that cannot say where it is belongs in the
  // summary.
  if (!Number.isFinite(line) || (end !== undefined && !Number.isFinite(end))) {
    return { kind: "off-diff" };
  }

  // The model writes both numbers, and nothing upstream requires them to be in
  // order. A span emitted backwards would produce `start_line > line`, which
  // GitHub rejects with a 422 — and a 422 discards every comment in the review,
  // which is the failure this module exists to prevent.
  const first = end !== undefined ? Math.min(line, end) : line;
  const last = end !== undefined ? Math.max(line, end) : line;

  const spans = last !== first;
  if (spans && sameRange(ranges, first, last)) {
    return { kind: "anchorable", line: last, start_line: first };
  }
  if (within(ranges, last)) return { kind: "anchorable", line: last };
  if (spans && within(ranges, first)) return { kind: "anchorable", line: first };

  // A changed region lying inside the span is what the finding is about, by
  // construction — the citation encloses the change. Distance from the two ends
  // would call that far away, so a wider citation would be less anchorable than
  // a narrow one, inverting what SNAP_LIMIT means.
  const enclosed = spans && ranges.find((r) => r.start >= first && r.end <= last);
  if (enclosed) return { kind: "off-hunk", line: enclosed.start };

  // Reachability considers both ends, the way the anchorable checks above do: a
  // span ending beside a hunk is as reachable as one starting beside it.
  //
  // The gate and the anchor have to measure the same end. Gating on the nearer
  // of the two and then anchoring on `first` leaves the snap unbounded: a
  // finding spanning 10-500 with a hunk at 505 passes on the end's distance of
  // 5 and then lands 495 lines from the code the body names — the outcome
  // SNAP_LIMIT exists to prevent. So the end that cleared the gate is the end
  // the comment goes next to. A tie goes to `first`, where the code begins.
  const nearFirst = nearest(ranges, first);
  const nearLast = spans ? nearest(ranges, last) : nearFirst;
  const best =
    !nearFirst ? nearLast
    : !nearLast ? nearFirst
    : nearLast.distance < nearFirst.distance ? nearLast
    : nearFirst;
  if (!best || best.distance > SNAP_LIMIT) return { kind: "off-diff" };
  return { kind: "off-hunk", line: best.line };
}
