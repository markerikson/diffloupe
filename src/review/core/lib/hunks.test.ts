
import {
  SNAP_LIMIT,
  anchorFor,
  compactDeletedFiles,
  compactForIntent,
  diffLines,
  diffSizes,
  parseDiffHunks,
  type HunkMap,
} from "./hunks.ts";

const hunks = (ranges: Record<string, [number, number][]>): HunkMap =>
  new Map(Object.entries(ranges).map(([f, rs]) => [f, rs.map(([start, end]) => ({ start, end }))]));

describe("parseDiffHunks", () => {
  it("reads added ranges per file", () => {
    const map = parseDiffHunks(
      ["--- a/x.ts", "+++ b/x.ts", "@@ -1,0 +2,3 @@", "+a", "+b", "+c", "@@ -9,1 +20,1 @@", "-old", "+new"].join(
        "\n",
      ),
    );
    expect(map.get("x.ts")).toEqual([
      { start: 2, end: 4 },
      { start: 20, end: 20 },
    ]);
  });

  it("treats a hunk with no added lines as nothing to anchor to", () => {
    const map = parseDiffHunks(["--- a/x.ts", "+++ b/x.ts", "@@ -4,3 +4,0 @@", "-a", "-b", "-c"].join("\n"));
    expect(map.get("x.ts")).toEqual([]);
  });

  it("leaves a deleted file out of the map", () => {
    const map = parseDiffHunks(["--- a/gone.ts", "+++ /dev/null", "@@ -1,3 +0,0 @@", "-a"].join("\n"));
    expect(map.has("gone.ts")).toBe(false);
  });

  it("gives a binary file an empty range list", () => {
    const map = parseDiffHunks(["--- a/i.png", "+++ b/i.png", "Binary files a/i.png and b/i.png differ"].join("\n"));
    expect(map.get("i.png")).toEqual([]);
  });

  // An added line reading `++ x` arrives as `+++ x`. Taking that for a file
  // header files every later hunk under a path that does not exist, and the
  // findings in them silently lose their anchors.
  it("does not mistake added content for a file header", () => {
    const map = parseDiffHunks(
      ["--- a/x.ts", "+++ b/x.ts", "@@ -1,0 +1,2 @@", "+++ i;", "+ x;", "@@ -8,0 +30,1 @@", "+y"].join("\n"),
    );
    expect([...map.keys()]).toEqual(["x.ts"]);
    expect(map.get("x.ts")).toEqual([
      { start: 1, end: 2 },
      { start: 30, end: 30 },
    ]);
  });

  // Content imitates the old-side header too: a deleted line reading `-- x`
  // arrives as `--- x`, and at zero context the additions follow the deletions
  // immediately, so `-- x` and `++ y` together read as a complete file header.
  it("does not mistake a deleted and an added line for a file header pair", () => {
    const map = parseDiffHunks(
      ["--- a/x.ts", "+++ b/x.ts", "@@ -5,1 +5,1 @@", "--- old;", "+++ new;", "@@ -8,0 +30,1 @@", "+y"].join("\n"),
    );
    expect([...map.keys()]).toEqual(["x.ts"]);
    expect(map.get("x.ts")).toEqual([
      { start: 5, end: 5 },
      { start: 30, end: 30 },
    ]);
  });

  // `diff.noprefix` drops the `a/` and `b/` prefixes. A parser that requires
  // them finds no files at all and reports every finding as off-diff.
  it("reads a diff written without path prefixes", () => {
    const map = parseDiffHunks(["--- x.ts", "+++ x.ts", "@@ -1,0 +2,1 @@", "+a"].join("\n"));
    expect(map.get("x.ts")).toEqual([{ start: 2, end: 2 }]);
  });

  it("keeps files apart across a multi-file diff", () => {
    const map = parseDiffHunks(
      [
        "diff --git a/x.ts b/x.ts",
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -1,0 +1,1 @@",
        "+a",
        "diff --git a/y.ts b/y.ts",
        "--- a/y.ts",
        "+++ b/y.ts",
        "@@ -1,0 +9,1 @@",
        "+b",
      ].join("\n"),
    );
    expect(map.get("x.ts")).toEqual([{ start: 1, end: 1 }]);
    expect(map.get("y.ts")).toEqual([{ start: 9, end: 9 }]);
  });
});

describe("diffLines", () => {
  it("reports the file each content line belongs to", () => {
    const out = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,0 +1,2 @@", "+one", "+two"].join("\n");
    const content = [...diffLines(out)].filter((l) => l.line.startsWith("+") && !l.line.startsWith("+++"));
    expect(content).toEqual([
      { file: "x.ts", line: "+one" },
      { file: "x.ts", line: "+two" },
    ]);
  });

  it("does not carry a deleted file's name onto its content", () => {
    const out = ["--- a/gone.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-a"].join("\n");
    expect([...diffLines(out)].every((l) => l.file === undefined)).toBe(true);
  });
});

describe("anchorFor", () => {
  const map = hunks({ "a.ts": [[100, 110]] });

  it("anchors a single changed line", () => {
    expect(anchorFor(map, "a.ts", 105)).toEqual({ kind: "anchorable", line: 105 });
  });

  // JSON has no undefined: a model that means "no end line" writes null, and
  // nothing between JSON.parse and this function normalizes it.
  it("treats a null end line as absent, not as unanchorable", () => {
    expect(anchorFor(map, "a.ts", 105, null)).toEqual({ kind: "anchorable", line: 105 });
  });

  it("anchors a span held by one changed region", () => {
    expect(anchorFor(map, "a.ts", 102, 108)).toEqual({ kind: "anchorable", line: 108, start_line: 102 });
  });

  // `start_line > line` is a 422, and a 422 discards every comment in the
  // review, not just the one that caused it.
  it("never emits a backwards span", () => {
    expect(anchorFor(map, "a.ts", 108, 102)).toEqual({ kind: "anchorable", line: 108, start_line: 102 });
  });

  it("collapses a span with only one end in the diff", () => {
    expect(anchorFor(map, "a.ts", 90, 105)).toEqual({ kind: "anchorable", line: 105 });
    expect(anchorFor(map, "a.ts", 105, 130)).toEqual({ kind: "anchorable", line: 105 });
  });

  it("collapses a span whose ends fall in two different regions", () => {
    const split = hunks({ "a.ts": [[10, 12], [50, 52]] });
    expect(anchorFor(split, "a.ts", 11, 51)).toEqual({ kind: "anchorable", line: 51 });
  });

  it("sends a file that is not in the diff to the summary", () => {
    expect(anchorFor(map, "other.ts", 5)).toEqual({ kind: "off-diff" });
  });

  // A missing or non-numeric line makes every comparison false rather than
  // throwing: the snap arithmetic yields NaN, and JSON.stringify writes that as
  // null, which GitHub 422s.
  it("sends an unusable line number to the summary", () => {
    expect(anchorFor(map, "a.ts", NaN)).toEqual({ kind: "off-diff" });
    expect(anchorFor(map, "a.ts", undefined as unknown as number)).toEqual({ kind: "off-diff" });
    expect(anchorFor(map, "a.ts", 105, NaN)).toEqual({ kind: "off-diff" });
  });

  it("snaps a nearby finding to the changed line", () => {
    expect(anchorFor(map, "a.ts", 95)).toEqual({ kind: "off-hunk", line: 100 });
    expect(anchorFor(map, "a.ts", 117)).toEqual({ kind: "off-hunk", line: 110 });
  });

  it("sends a distant finding to the summary rather than pointing at unrelated code", () => {
    expect(anchorFor(map, "a.ts", 300)).toEqual({ kind: "off-diff" });
  });

  // The gate and the anchor have to measure the same end. Gating on the nearer
  // end and then anchoring on the start leaves the snap unbounded: this span
  // clears the limit on its end's distance of 5 and used to land at line 5,
  // 495 lines from the code the comment body names.
  it("snaps to whichever end cleared the distance limit", () => {
    const far = hunks({ "a.ts": [[505, 506]] });
    expect(anchorFor(far, "a.ts", 10, 500)).toEqual({ kind: "off-hunk", line: 505 });

    const near = hunks({ "a.ts": [[5, 6]] });
    expect(anchorFor(near, "a.ts", 10, 500)).toEqual({ kind: "off-hunk", line: 6 });
  });

  it("breaks a tie in favour of where the code begins", () => {
    const both = hunks({ "a.ts": [[5, 5], [35, 35]] });
    expect(anchorFor(both, "a.ts", 10, 30)).toEqual({ kind: "off-hunk", line: 5 });
  });

  // A citation wider than the change is the ordinary shape for "this function
  // is wrong, and here is the line you touched inside it". Measuring only from
  // the two ends made a wider citation less anchorable than a narrow one.
  it("anchors to a changed region the finding encloses", () => {
    const inside = hunks({ "a.ts": [[200, 210]] });
    expect(anchorFor(inside, "a.ts", 100, 400)).toEqual({ kind: "off-hunk", line: 200 });
  });

  // The invariant SNAP_LIMIT exists to enforce, checked over the whole space
  // rather than at the handful of points that happened to come up. A comment
  // lands either within the limit of an end of the citation, or inside it.
  it("never moves a comment away from the finding", () => {
    const ranges: [number, number][] = [[200, 210], [400, 400]];
    const m = hunks({ "a.ts": ranges });
    for (let start = 1; start <= 500; start += 7) {
      for (const length of [0, 1, 5, 50, 300]) {
        const end = start + length;
        const anchor = anchorFor(m, "a.ts", start, end);
        if (anchor.kind !== "off-hunk") continue;
        const distance = Math.min(Math.abs(anchor.line! - start), Math.abs(anchor.line! - end));
        const enclosed = anchor.line! >= start && anchor.line! <= end;
        expect(enclosed || distance <= SNAP_LIMIT).toBe(true);
      }
    }
  });

  it("keeps an anchored span inside a single changed region", () => {
    const m = hunks({ "a.ts": [[100, 110], [200, 210]] });
    for (let start = 90; start <= 220; start++) {
      for (const length of [0, 3, 40, 120]) {
        const anchor = anchorFor(m, "a.ts", start, start + length);
        if (anchor.start_line === undefined) continue;
        const held = [
          { start: 100, end: 110 },
          { start: 200, end: 210 },
        ].some((r) => anchor.start_line! >= r.start && anchor.line! <= r.end);
        expect(held).toBe(true);
        expect(anchor.start_line!).toBeLessThanOrEqual(anchor.line!);
      }
    }
  });
});

describe("diffSizes", () => {
  it("sizes each file separately", () => {
    const sizes = diffSizes(
      [
        "diff --git a/x.ts b/x.ts",
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -1,0 +2,1 @@",
        "+aaaa",
        "diff --git a/y.ts b/y.ts",
        "--- a/y.ts",
        "+++ b/y.ts",
        "@@ -1,0 +2,1 @@",
        "+bb",
      ].join("\n"),
    );
    expect([...sizes.keys()].sort()).toEqual(["x.ts", "y.ts"]);
    // x.ts carries one more content character than y.ts.
    expect(sizes.get("x.ts")! - sizes.get("y.ts")!).toBe(2);
  });

  it("bills a deleted file to the path it was deleted from", () => {
    // The shared diff walker leaves deletions unattributed, because a deleted
    // file has no new-side line to anchor a comment to. A packer that reused it
    // would size every deletion at zero and let it ride along for free.
    const sizes = diffSizes(
      ["diff --git a/gone.ts b/gone.ts", "--- a/gone.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-one", "-two"].join(
        "\n",
      ),
    );
    expect(sizes.get("gone.ts")).toBeGreaterThan(0);
  });

  it("reads paths written without a/ and b/ prefixes", () => {
    const sizes = diffSizes(["diff --git x.ts x.ts", "--- x.ts", "+++ x.ts", "@@ -1,0 +2,1 @@", "+a"].join("\n"));
    expect([...sizes.keys()]).toEqual(["x.ts"]);
  });
});

describe("compactDeletedFiles", () => {
  const deleted = (name: string, body: string[]) => [
    `diff --git a/${name} b/${name}`,
    "deleted file mode 100644",
    "index 1111111..0000000",
    `--- a/${name}`,
    "+++ /dev/null",
    `@@ -1,${body.length} +0,0 @@`,
    ...body.map((l) => `-${l}`),
  ];
  const kept = [
    "diff --git a/kept.ts b/kept.ts",
    "--- a/kept.ts",
    "+++ b/kept.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ];
  const longBody = [
    "import { x } from './x';",
    "export function removedHelper(a: number) {",
    ...Array.from({ length: 60 }, (_, i) => `  const v${i} = a + ${i};`),
    "}",
    "class Widget {",
    "  method() {}",
    "}",
  ];

  it("cuts a long deleted file to its declarations and leaves other files alone", () => {
    const diff = [...deleted("gone.ts", longBody), ...kept].join("\n") + "\n";
    const out = compactDeletedFiles(diff, "abcdef1234567890");
    expect(out).toContain("-export function removedHelper(a: number) {");
    expect(out).toContain("-class Widget {");
    expect(out).not.toContain("const v10");
    expect(out).toContain("git show abcdef123456:gone.ts");
    expect(out).toContain("+new");
    expect(out.endsWith("\n")).toBe(true);
    // The rewritten section still parses, and is billed far less than before.
    const before = diffSizes(diff).get("gone.ts")!;
    const after = diffSizes(out).get("gone.ts")!;
    expect(after).toBeLessThan(before / 4);
    expect(parseDiffHunks(out).get("kept.ts")).toEqual([{ start: 1, end: 1 }]);
  });

  it("shows a short deleted file whole", () => {
    const diff = deleted("small.ts", ["export const a = 1;", "export const b = 2;"]).join("\n");
    expect(compactDeletedFiles(diff, "abc")).toBe(diff);
  });
});

describe("compactForIntent", () => {
  const file = (name: string, lines: number, width = 20) =>
    [
      `diff --git a/${name} b/${name}`,
      `--- a/${name}`,
      `+++ b/${name}`,
      `@@ -0,0 +1,${lines} @@`,
      ...Array.from({ length: lines }, (_, i) => `+${String(i).padStart(width, "x")}`),
    ].join("\n") + "\n";

  it("returns a diff under the budget unchanged", () => {
    const diff = file("a.ts", 5) + file("b.ts", 5);
    expect(compactForIntent(diff, 10_000)).toBe(diff);
  });

  it("keeps every file within the budget, small files whole and large ones cut with a marker", () => {
    const small = file("small.ts", 3);
    const diff = small + file("big.ts", 2000) + file("bigger.ts", 4000);
    const out = compactForIntent(diff, 20_000);
    expect(out.length).toBeLessThanOrEqual(20_000);
    expect(out).toContain(small);
    for (const name of ["big.ts", "bigger.ts"]) expect(out).toContain(`diff --git a/${name} b/${name}`);
    expect(out).toMatch(/\[\d+ more lines in this file\]/);
  });

  it("shows the start of a single huge line instead of dropping the file", () => {
    const diff = file("data.json", 1, 100_000) + file("code.ts", 10);
    const out = compactForIntent(diff, 4000);
    expect(out).toContain("[rest of line cut]");
    expect(out).toContain("+++ b/data.json");
    expect(out).toContain("+++ b/code.ts");
  });
});
