import { describe, expect, test } from "bun:test";
import { loadFixture } from "./__fixtures__/load.ts";
import { describeAnchors } from "./anchors.ts";
import { type } from "arktype";
import { buildPendingRun, buildReviewRun } from "./build-run.ts";
import { ReviewRunSchema, type DiffAnchor, type ReviewRun } from "../types/review-run.ts";

const FIXTURES = ["small-commit", "large-pr", "renames", "worktree", "docs-only"];

/** Head-side and base-side text of every line a patch shows, keyed by `path:line`, read straight from the hunks. */
function patchLines(patch: string): { additions: Map<string, string>; deletions: Map<string, string> } {
  const additions = new Map<string, string>();
  const deletions = new Map<string, string>();
  let path = "";
  let oldPath = "";
  let a = 0;
  let d = 0;
  for (const line of patch.split("\n")) {
    const header = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
    if (header) {
      oldPath = header[1]!;
      path = header[2]!;
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      d = Number(hunk[1]);
      a = Number(hunk[2]);
      continue;
    }
    if (!a && !d) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) additions.set(`${path}:${a++}`, line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---")) deletions.set(`${oldPath}:${d++}`, line.slice(1));
    else if (line.startsWith(" ")) {
      additions.set(`${path}:${a++}`, line.slice(1));
      deletions.set(`${oldPath}:${d++}`, line.slice(1));
    } else if (!line.startsWith("\\")) {
      a = 0;
      d = 0;
    }
  }
  return { additions, deletions };
}

function allAnchors(run: ReviewRun): DiffAnchor[] {
  return [
    ...run.findings.map((f) => f.anchor),
    ...run.overCapFindings.map((f) => f.anchor),
    ...run.stops.flatMap((s) => s.locations),
  ];
}

describe.each(FIXTURES)("buildReviewRun: %s", (name) => {
  const fx = loadFixture(name);
  const run = fx.build();

  test("every file in the patch sits in exactly one group", () => {
    const seen = new Map<string, number>();
    for (const g of run.groups) for (const f of g.files) seen.set(f, (seen.get(f) ?? 0) + 1);
    for (const f of run.files) {
      expect(seen.get(f.path)).toBe(1);
      expect(run.groups.find((g) => g.id === f.groupId)?.files).toContain(f.path);
    }
    expect([...seen.keys()].sort()).toEqual(run.files.map((f) => f.path).sort());
  });

  test("parents come before their children and hold no files", () => {
    const ids = new Set<string>();
    for (const g of run.groups) {
      if (g.parentId) {
        expect(ids.has(g.parentId)).toBe(true);
        expect(run.groups.find((p) => p.id === g.parentId)?.files).toEqual([]);
      }
      ids.add(g.id);
    }
  });

  test("every anchor is on a visible line, or is a file anchor with a reason", () => {
    const lines = patchLines(fx.patch);
    const kinds = { line: 0, nearby: 0, file: 0 };
    for (const a of allAnchors(run)) {
      kinds[a.kind]++;
      if (a.kind === "file") {
        expect(a.line).toBe(0);
        expect(a.reason).toBeDefined();
        continue;
      }
      const shown = a.side === "additions" ? lines.additions : lines.deletions;
      expect(shown.get(`${a.file}:${a.line}`)).toBe(a.text!);
      if (a.endLine !== undefined) expect(shown.has(`${a.file}:${a.endLine}`)).toBe(true);
    }
    console.log(`  ${name}: ${kinds.line} line, ${kinds.nearby} nearby, ${kinds.file} file anchors`);
  });

  test("group finding and stop ids point at real findings and stops", () => {
    const findingIds = new Set(run.findings.map((f) => f.id));
    const stopIds = new Set(run.stops.map((s) => s.id));
    for (const g of run.groups) {
      for (const id of g.findingIds) expect(findingIds.has(id)).toBe(true);
      for (const id of g.stopIds) expect(stopIds.has(id)).toBe(true);
    }
    expect(findingIds.size).toBe(run.findings.length);
  });
});

describe("buildReviewRun details", () => {
  test("large PR: chapters, supporting units, trailing groups and intent", () => {
    const fx = loadFixture("large-pr");
    const run = fx.build();
    expect(run.groups.map((g) => [g.id, g.parentId ?? null])).toEqual([
      ["c1", null],
      ["u-api", "c1"],
      ["c2", null],
      ["u-db", "c2"],
      ["supporting", null],
      ["u-ui", "supporting"],
      ["other", null],
      ["remaining", "other"],
      ["docs", "other"],
      ["skipped", "other"],
    ]);
    const group = (id: string) => run.groups.find((g) => g.id === id)!;
    expect(group("c1")).toMatchObject({ title: "Request path", icon: "path", critical: true, stopIds: ["c1-s1", "c1-s2"] });
    expect(group("supporting").summary).toBe("Style tweak");
    expect(group("remaining").files).toEqual(["src/util/misc.ts"]);
    expect(group("docs").files).toEqual(["docs/guide.md"]);
    expect(group("skipped").files).toEqual(["bun.lock"]);
    expect(group("u-ui").critical).toBe(false);

    expect(describeAnchors(run)).toMatch(/^7 line, 2 nearby, 5 file \([a-z-]+(, [a-z-]+)*\)$/);
    expect(run.stops[1]!.locations).toHaveLength(1);
    expect(run.overCapFindings).toHaveLength(2);
    expect(run.unreviewed).toEqual({ overCap: ["src/ui/button.tsx"], failed: ["Database 2/2"] });
    expect(run.resolved).toEqual([{ id: "12345", note: "fixed in a later push" }]);
    expect(run.intent.alignment).toBe("partial");
    expect(run.intent.unstated).toEqual(["schema change"]);
    expect(run.intent.mismatches?.[0]).toBe("The stated intent leaves out the schema change.");
    expect(run.overview).toEqual({
      focus: "New routes read user input straight into the server constants.",
      changeType: "feature",
      startHere: [{ file: "src/api/routes.ts", why: "The new entry point" }],
    });
    expect(run.meta).toMatchObject({ model: "anthropic/claude-sonnet", costUsd: 1.5, rejectedCount: 1, mergeMode: "coordinator" });
    expect(run.meta.slices.map((s) => s.status)).toEqual(["ok", "ok", "failed"]);

    const blocker = run.findings.find((f) => f.severity === "blocker")!;
    expect(blocker.crossFileRefs).toEqual([{ file: "src/db/schema.ts", line: 5 }, { file: "src/api/routes.ts" }]);
    expect(run.findings.find((f) => f.file === "src/gone.ts")?.anchor.reason).toBe("not-in-diff");
    expect(fx.logs).toEqual([
      '  walkthrough: dropped directory location src/api in "Route table"',
      "  1 file(s) in no review unit: src/util/misc.ts",
      "  1 finding(s) name files outside the patch",
    ]);
  });

  test("a unit spread over chapters splits into one leaf per chapter", () => {
    const fx = loadFixture("large-pr");
    const run = buildReviewRun({
      ...fx.input,
      log: () => {},
      result: {
        ...fx.input.result,
        units: [
          {
            id: "all",
            title: "Everything",
            files: ["src/api/server.ts", "test/query.test.ts", "src/api/routes.ts", "src/db/query.ts", "src/db/schema.ts"],
          },
        ],
      },
    });
    const leaves = run.groups.filter((g) => g.id.startsWith("u-"));
    expect(leaves.map((g) => [g.id, g.parentId, g.title, g.files])).toEqual([
      ["u-all-c1", "c1", "Everything", ["src/api/server.ts", "src/api/routes.ts"]],
      ["u-all-c2", "c2", "Everything", ["test/query.test.ts", "src/db/query.ts", "src/db/schema.ts"]],
    ]);
  });

  test("uncited files follow their subject, then the deepest shared directory", () => {
    const fx = loadFixture("large-pr");
    const run = buildReviewRun({
      ...fx.input,
      log: () => {},
      result: {
        ...fx.input.result,
        units: [{ id: "all", title: "Everything", files: ["src/api/routes.ts", "src/db/query.ts", "src/db/schema.ts", "src/util/misc.ts"] }],
      },
    });
    const parentOf = (file: string) => run.groups.find((g) => g.files.includes(file))?.parentId;
    expect(parentOf("src/api/routes.ts")).toBe("c1");
    expect(parentOf("src/db/schema.ts")).toBe("c2");
    // Shares only `src/` with both chapters, so it takes the earlier one.
    expect(parentOf("src/util/misc.ts")).toBe("c1");
  });

  test("renames: statuses, previous paths, binary and removed files", () => {
    const run = loadFixture("renames").build();
    const file = (p: string) => run.files.find((f) => f.path === p)!;
    expect(file("src/new-name.ts")).toMatchObject({ status: "renamed", previousPath: "src/old-name.ts" });
    expect(file("lib/moved-pure.ts")).toMatchObject({ status: "renamed", previousPath: "src/moved-pure.ts", additions: 0 });
    expect(file("src/removed.ts")).toMatchObject({ status: "removed", deletions: 20 });
    expect(file("assets/logo.png")).toMatchObject({ status: "modified", isBinary: true });
    expect(run.stops[0]!.locations[0]).toMatchObject({ side: "deletions", kind: "line", line: 5, label: "removed5" });
  });

  test("no walkthrough: flat leaf groups in priority order", () => {
    const run = loadFixture("worktree").build();
    expect(run.groups.map((g) => [g.id, g.parentId ?? null])).toEqual([
      ["u-app", null],
      ["other", null],
      ["docs", "other"],
    ]);
    expect(run.target).toEqual({ kind: "worktree", branch: "main" });
    expect(run.untrackedSkipped).toEqual(["big.bin"]);
  });

  test("no record: every file lands in the trailing groups", () => {
    const run = loadFixture("docs-only").build();
    expect(run.status).toBe("complete");
    expect(run.findings).toEqual([]);
    expect(run.groups.map((g) => g.id)).toEqual(["other", "docs", "skipped"]);
  });
});

describe("ReviewRunSchema", () => {
  for (const name of FIXTURES) {
    test(`${name}: built run validates`, () => {
      const out = ReviewRunSchema(loadFixture(name).build());
      expect(out instanceof type.errors ? out.summary : "ok").toBe("ok");
    });
  }

  test("pending run validates", () => {
    const fixture = loadFixture("large-pr");
    const { id, createdAt, repo, target, base, head, patch, coreSource } = fixture.input;
    const out = ReviewRunSchema(buildPendingRun({ id, createdAt, repo, target, base, head, patch, coreSource }));
    expect(out instanceof type.errors ? out.summary : "ok").toBe("ok");
  });
});
