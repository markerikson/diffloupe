
import { parseDiff, shape } from "./registry-check.ts";

/**
 * Two registry entries are siblings when their lines have the same structure and
 * differ only in the names they carry. `shape` is what decides that, and both
 * directions of error are silent: too coarse and unrelated lines pair up, too
 * fine and a real registry's entries stop matching each other.
 */
describe("shape", () => {
  it("matches two entries that differ only in their names", () => {
    expect(shape("  Foo: fooHandler,")).toBe(shape("  Bar: barHandler,"));
  });

  it("keeps a string distinct from a bare identifier", () => {
    // Both collapsed to the same placeholder letter, the identifier pass ate the
    // string's placeholder and these became the same shape.
    expect(shape('register("foo")')).not.toBe(shape("register(foo)"));
  });

  it("matches two entries whose numbers differ", () => {
    expect(shape("  [0]: first,")).toBe(shape("  [12]: second,"));
  });

  it("separates lines with genuinely different structure", () => {
    expect(shape("  Foo: fooHandler,")).not.toBe(shape("  Foo: fooHandler(extra),"));
  });

  it("ignores indentation", () => {
    expect(shape("Foo: a,")).toBe(shape("      Foo: a,"));
  });
});

/**
 * Built on the shared `diffLines` walker so the diff-format knowledge cannot
 * drift from the anchoring pass. The case that motivated the move: with
 * `diff.noprefix` in a developer's git config there is no `b/` on the header,
 * and a parser requiring the literal prefix finds no files at all — the check
 * runs, reports nothing, and looks like a clean result.
 */
describe("parseDiff", () => {
  const diff = (header: string) =>
    [
      `diff --git a/x.ts b/x.ts`,
      `--- ${header.replace("b/", "a/")}`,
      `+++ ${header}`,
      "@@ -1,2 +1,3 @@",
      " context",
      "+added",
      " more",
      "",
    ].join("\n");

  it("reads the file name with the b/ prefix", () => {
    const hunks = parseDiff(diff("b/x.ts"));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.file).toBe("x.ts");
    expect(hunks[0]!.lines.find((l) => l.kind === "add")).toEqual({
      kind: "add",
      text: "added",
      newLine: 2,
    });
  });

  it("reads the file name without it, as diff.noprefix emits", () => {
    const hunks = parseDiff(diff("x.ts"));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.file).toBe("x.ts");
  });

  it("attaches no hunk to a deleted file", () => {
    const del = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-first",
      "-second",
      "",
    ].join("\n");
    expect(parseDiff(del)).toHaveLength(0);
  });
});
