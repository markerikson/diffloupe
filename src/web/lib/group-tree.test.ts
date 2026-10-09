import { describe, expect, test } from "bun:test";
import { loadFixture } from "../../review/__fixtures__/load.ts";
import type { RunGroup } from "../../types/review-run.ts";
import { buildGroupTree } from "./group-tree.ts";

describe("buildGroupTree", () => {
  for (const name of ["large-pr", "renames", "worktree", "small-commit", "docs-only"]) {
    test(`${name}: every file lands in exactly one unit and order follows run.groups`, () => {
      const run = loadFixture(name).build();
      const tree = buildGroupTree(run.groups, run.files);

      expect(tree.ordered.map((g) => g.id)).toEqual(run.groups.map((g) => g.id));

      const seen = new Map<string, number>();
      for (const g of tree.ordered) for (const p of g.files) seen.set(p, (seen.get(p) ?? 0) + 1);
      for (const f of run.files) expect(seen.get(f.path)).toBe(1);

      const totals = { files: 0, additions: 0, deletions: 0 };
      for (const { chapter, units } of tree.chapters) {
        const sum = { files: 0, additions: 0, deletions: 0 };
        for (const u of units) {
          const s = tree.stats.get(u.id)!;
          sum.files += s.files;
          sum.additions += s.additions;
          sum.deletions += s.deletions;
        }
        if (chapter) {
          const s = tree.stats.get(chapter.id)!;
          expect(s.files).toBe(sum.files + chapter.files.length);
          totals.files += s.files;
          totals.additions += s.additions;
          totals.deletions += s.deletions;
        } else {
          totals.files += sum.files;
          totals.additions += sum.additions;
          totals.deletions += sum.deletions;
        }
      }
      expect(totals.files).toBe(run.files.length);
      expect(totals.additions).toBe(run.files.reduce((n, f) => n + f.additions, 0));
      expect(totals.deletions).toBe(run.files.reduce((n, f) => n + f.deletions, 0));
    });
  }

  const g = (id: string, extra: Partial<RunGroup> = {}): RunGroup => ({
    id,
    title: id,
    files: [],
    findingIds: [],
    stopIds: [],
    critical: false,
    ...extra,
  });

  test("a chapter with no units still gets an entry", () => {
    const tree = buildGroupTree([g("intro"), g("u1", { files: ["a.ts"] })], []);
    expect(tree.chapters.map((c) => [c.chapter?.id ?? null, c.units.map((u) => u.id)])).toEqual([
      ["intro", []],
      [null, ["u1"]],
    ]);
  });

  test("critical rolls up from a unit to its chapter", () => {
    const tree = buildGroupTree(
      [g("ch"), g("u1", { parentId: "ch", files: ["a.ts"], critical: true }), g("u2", { parentId: "ch", files: ["b.ts"] })],
      [],
    );
    expect(tree.stats.get("ch")?.critical).toBe(true);
    expect(tree.stats.get("u2")?.critical).toBe(false);
  });
});
