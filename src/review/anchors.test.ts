import { describe, expect, test } from "bun:test";
import { anchor, locationSymbol, SNAP_LIMIT, snapToSymbol, visibleRanges } from "./anchors.ts";
import { parseRunPatch } from "./build-run.ts";

function numbered(prefix: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${prefix}${i}`);
  return out;
}

/** Hunks at head lines 7-13 (changed line 10) and 97-103 (changed line 100) of a 120-line file. */
const MODIFIED = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -7,7 +7,7 @@",
  ...numbered(" line", 7, 9),
  "-line10",
  "+LINE10",
  ...numbered(" line", 11, 13),
  "@@ -97,7 +97,7 @@",
  ...numbered(" line", 97, 99),
  "-line100",
  "+LINE100",
  ...numbered(" line", 101, 103),
  "",
].join("\n");

const DELETED = [
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "index 3333333333333333333333333333333333333333..0000000000000000000000000000000000000000",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,3 +0,0 @@",
  "-gone1",
  "-gone2",
  "-gone3",
  "",
].join("\n");

const NO_NEWLINE = [
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000000000000000000000000000000000000..4444444444444444444444444444444444444444",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+first",
  "+second",
  "\\ No newline at end of file",
  "",
].join("\n");

const RENAME_PURE = [
  "diff --git a/src/old.ts b/lib/new.ts",
  "similarity index 100%",
  "rename from src/old.ts",
  "rename to lib/new.ts",
  "",
].join("\n");

const RENAME_CHANGED = [
  "diff --git a/src/old.ts b/lib/new.ts",
  "similarity index 90%",
  "rename from src/old.ts",
  "rename to lib/new.ts",
  "index 5555555555555555555555555555555555555555..6666666666666666666666666666666666666666 100644",
  "--- a/src/old.ts",
  "+++ b/lib/new.ts",
  "@@ -1,3 +1,3 @@",
  " keep1",
  "-old2",
  "+new2",
  " keep3",
  "",
].join("\n");

function one(patch: string) {
  const files = parseRunPatch(patch);
  expect(files).toHaveLength(1);
  return files[0]!;
}

describe("visibleRanges", () => {
  test("covers each hunk's head-side span", () => {
    expect(visibleRanges(one(MODIFIED), "additions").map((r) => [r.start, r.end])).toEqual([
      [7, 13],
      [97, 103],
    ]);
    expect(visibleRanges(one(MODIFIED), "deletions").map((r) => [r.start, r.end])).toEqual([
      [7, 13],
      [97, 103],
    ]);
  });

  test("a deleted file has no head-side span", () => {
    expect(visibleRanges(one(DELETED), "additions")).toEqual([]);
    expect(visibleRanges(one(DELETED), "deletions").map((r) => [r.start, r.end])).toEqual([[1, 3]]);
  });
});

describe("anchor", () => {
  const file = one(MODIFIED);

  test("a visible line is a line anchor with its text", () => {
    expect(anchor(file, "src/a.ts", 10)).toEqual({
      file: "src/a.ts",
      side: "additions",
      kind: "line",
      line: 10,
      cited: { line: 10 },
      text: "LINE10",
    });
    expect(anchor(file, "src/a.ts", 7).text).toBe("line7");
    expect(anchor(file, "src/a.ts", 103).text).toBe("line103");
  });

  test("a range is clamped to the end of its hunk and keeps the cited range", () => {
    expect(anchor(file, "src/a.ts", 11, 30)).toMatchObject({
      kind: "line",
      line: 11,
      endLine: 13,
      cited: { line: 11, endLine: 30 },
    });
  });

  test("a reversed range is normalized", () => {
    expect(anchor(file, "src/a.ts", 12, 10)).toMatchObject({ line: 10, endLine: 12, cited: { line: 10, endLine: 12 } });
  });

  test("a line close to a hunk snaps to the nearest visible line", () => {
    expect(anchor(file, "src/a.ts", 25)).toEqual({
      file: "src/a.ts",
      side: "additions",
      kind: "nearby",
      line: 13,
      cited: { line: 25 },
      text: "line13",
    });
    expect(anchor(file, "src/a.ts", 90)).toMatchObject({ kind: "nearby", line: 97 });
    expect(anchor(file, "src/a.ts", 13 + SNAP_LIMIT)).toMatchObject({ kind: "nearby", line: 13 });
  });

  test("a line far from every hunk is a file anchor", () => {
    expect(anchor(file, "src/a.ts", 13 + SNAP_LIMIT + 1)).toEqual({
      file: "src/a.ts",
      side: "additions",
      kind: "file",
      line: 0,
      cited: { line: 34 },
      reason: "far-from-diff",
    });
  });

  test("no line or a zero line is a file anchor", () => {
    expect(anchor(file, "src/a.ts")).toMatchObject({ kind: "file", line: 0, reason: "no-line" });
    expect(anchor(file, "src/a.ts", 0)).toMatchObject({ kind: "file", reason: "no-line" });
  });

  test("a file the patch does not touch is a file anchor", () => {
    expect(anchor(undefined, "src/other.ts", 5)).toMatchObject({
      file: "src/other.ts",
      kind: "file",
      reason: "not-in-diff",
      cited: { line: 5 },
    });
  });

  test("a deleted file anchors to the file unless the deletions fallback hits", () => {
    const gone = one(DELETED);
    expect(anchor(gone, "src/gone.ts", 2)).toMatchObject({ kind: "file", reason: "deleted-file" });
    expect(anchor(gone, "src/gone.ts", 2, undefined, { deletionsFallback: true })).toMatchObject({
      side: "deletions",
      kind: "line",
      line: 2,
      text: "gone2",
    });
    expect(anchor(gone, "src/gone.ts", 9, undefined, { deletionsFallback: true })).toMatchObject({
      kind: "file",
      reason: "deleted-file",
    });
  });

  test("the deletions fallback is tried before snapping", () => {
    const changed = one(RENAME_CHANGED);
    expect(anchor(changed, "lib/new.ts", 2)).toMatchObject({ side: "additions", kind: "line", text: "new2" });
    // Both sides show line 2, so the head side wins.
    expect(anchor(changed, "lib/new.ts", 2, undefined, { deletionsFallback: true }).side).toBe("additions");
  });

  test("the last line of a file without a trailing newline", () => {
    const f = one(NO_NEWLINE);
    expect(anchor(f, "src/new.ts", 2)).toMatchObject({ kind: "line", line: 2, text: "second" });
    expect(anchor(f, "src/new.ts", 1).text).toBe("first");
  });

  test("a pure rename has no hunks", () => {
    const f = one(RENAME_PURE);
    expect(f.name).toBe("lib/new.ts");
    expect(anchor(f, "lib/new.ts", 3)).toMatchObject({ kind: "file", reason: "no-hunks" });
  });

  test("a changed rename anchors on the new path's lines", () => {
    const f = one(RENAME_CHANGED);
    expect(f.prevName).toBe("src/old.ts");
    expect(anchor(f, "lib/new.ts", 3)).toMatchObject({ kind: "line", line: 3, text: "keep3" });
  });
});

/** A new 60-line file: `dispose` defined at 40 and called at 12 and 55; `run` defined at 20. */
const NEW_FILE = (() => {
  const body = numbered("+const filler", 1, 60);
  body[11] = "+  this.dispose();";
  body[19] = "+export async function run(fn: () => void) {";
  body[39] = "+  async dispose(): Promise<void> {";
  body[54] = "+    void session.dispose();";
  return [
    "diff --git a/src/session.ts b/src/session.ts",
    "new file mode 100644",
    "index 0000000000000000000000000000000000000000..7777777777777777777777777777777777777777",
    "--- /dev/null",
    "+++ b/src/session.ts",
    "@@ -0,0 +1,60 @@",
    ...body,
    "",
  ].join("\n");
})();

describe("locationSymbol", () => {
  test("prefers symbol, accepts a one-identifier label, takes the last dotted segment", () => {
    expect(locationSymbol("dispose", "teardown path")).toBe("dispose");
    expect(locationSymbol(undefined, "Session.dispose")).toBe("dispose");
    expect(locationSymbol(undefined, "dispose()")).toBe("dispose");
    expect(locationSymbol(undefined, "dispose and run")).toBeUndefined();
    expect(locationSymbol("  ", undefined)).toBeUndefined();
  });
});

describe("snapToSymbol", () => {
  const f = one(NEW_FILE);
  const at = (line: number) => anchor(f, "src/session.ts", line);

  test("keeps a line that already holds the symbol", () => {
    const a = at(55);
    expect(snapToSymbol(f, a, "dispose")).toBe(a);
  });

  test("moves a miscounted line to the definition, keeping the cited line", () => {
    expect(snapToSymbol(f, at(30), "dispose")).toMatchObject({
      kind: "line",
      line: 40,
      cited: { line: 30 },
      text: "  async dispose(): Promise<void> {",
    });
    expect(snapToSymbol(f, at(48), "run")).toMatchObject({ line: 20 });
  });

  test("a use within a few lines of the cited line wins over the definition", () => {
    expect(snapToSymbol(f, at(14), "dispose")).toMatchObject({ line: 12 });
  });

  test("does not match the symbol inside a longer identifier", () => {
    expect(snapToSymbol(f, at(30), "dis")).toMatchObject({ line: 30 });
  });

  test("leaves the anchor alone when the symbol is not in the diff", () => {
    const a = at(30);
    expect(snapToSymbol(f, a, "missing")).toBe(a);
    expect(snapToSymbol(undefined, a, "dispose")).toBe(a);
  });

  test("repairs a file-level anchor whose line was out of range", () => {
    const a = at(400);
    expect(a.kind).toBe("file");
    expect(snapToSymbol(f, a, "dispose")).toMatchObject({ kind: "line", line: 40, cited: { line: 400 } });
  });

  test("searches removed lines with the deletions fallback", () => {
    const d = one(DELETED);
    const a = anchor(d, "src/gone.ts", 1, undefined, { deletionsFallback: true });
    expect(snapToSymbol(d, a, "gone3", { deletionsFallback: true })).toMatchObject({
      side: "deletions",
      line: 3,
    });
  });
});
