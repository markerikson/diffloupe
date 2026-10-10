import { describe, expect, test } from "bun:test";
import { loadFixture } from "../../review/__fixtures__/load.ts";
import { buildGroupTree } from "./group-tree.ts";
import { navLists, neighbor } from "./navigation.ts";

describe("navLists", () => {
  for (const name of ["large-pr", "renames", "worktree", "small-commit", "docs-only"]) {
    test(`${name}: files and findings follow the group tree`, () => {
      const run = loadFixture(name).build();
      const tree = buildGroupTree(run.groups, run.files, run);
      const { files, findings, stops } = navLists(run, tree);

      const expected = tree.ordered.flatMap((g) => run.files.filter((f) => f.groupId === g.id).map((f) => f.path));
      expect(files.map((f) => f.path)).toEqual(expected);
      expect(files.length).toBe(run.files.length);

      const pageIndex = new Map(files.map((f, i) => [f.path, i]));
      const order = findings.map((f) => pageIndex.get(f.anchor.file)!);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(findings.length).toBe(run.findings.filter((f) => pageIndex.has(f.anchor.file)).length);
      expect(stops.map((s) => s.id)).toEqual(run.stops.map((s) => s.id));
    });
  }

  test("large-pr: findings on files outside the diff are left out; over-cap only when asked", () => {
    const run = loadFixture("large-pr").build();
    const tree = buildGroupTree(run.groups, run.files, run);
    const plain = navLists(run, tree);
    expect(plain.findings.some((f) => f.file === "src/gone.ts")).toBe(false);
    const withOverCap = navLists(run, tree, { showOverCap: true });
    expect(withOverCap.findings.length).toBeGreaterThan(plain.findings.length);
  });
});

describe("neighbor", () => {
  const ids = ["a", "b", "c"];
  test("moves forward and back", () => {
    expect(neighbor(ids, "a", 1)).toBe("b");
    expect(neighbor(ids, "c", -1)).toBe("b");
  });
  test("does not wrap at the ends", () => {
    expect(neighbor(ids, "c", 1)).toBeUndefined();
    expect(neighbor(ids, "a", -1)).toBeUndefined();
  });
  test("starts at the first item with no current id", () => {
    expect(neighbor(ids, undefined, 1)).toBe("a");
    expect(neighbor(ids, undefined, -1)).toBe("a");
    expect(neighbor([], undefined, 1)).toBeUndefined();
  });
});
