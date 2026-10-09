/**
 * Adapted from pulls.review (https://github.com/antfu/pulls.review,
 * packages/app/src/components/diff/file-rows.test.ts @ a64631f), MIT.
 */
import { describe, expect, test } from "bun:test";
import type { RunFile } from "../../types/review-run.ts";
import { fileRows } from "./file-rows.ts";

function file(path: string): RunFile {
  return { path, status: "modified", additions: 1, deletions: 1, isBinary: false, groupId: "g", classification: "code" };
}

function outline(rows: ReturnType<typeof fileRows>) {
  return rows.map((row) => `${"  ".repeat(row.depth)}${row.type === "folder" ? `${row.name}/` : row.name}`);
}

describe("fileRows", () => {
  test("keeps the diff order in the tree, placing each folder where its first file appears", () => {
    const files = ["z.ts", "src/b.ts", "docs/x.md", "src/a.ts"].map(file);
    expect(outline(fileRows(files, ["old.ts"], "tree"))).toEqual([
      "z.ts",
      "src/",
      "  b.ts",
      "  a.ts",
      "docs/",
      "  x.md",
      "old.ts",
    ]);
  });

  test("collapses single-child folder chains", () => {
    expect(outline(fileRows(["a/b/c.ts", "a/b/d.ts"].map(file), [], "tree"))).toEqual(["a/b/", "  c.ts", "  d.ts"]);
  });

  test("folder rows carry every nested file", () => {
    const rows = fileRows(["a/x/c.ts", "a/y/d.ts"].map(file), [], "tree");
    expect(rows[0]?.files?.map((f) => f.path)).toEqual(["a/x/c.ts", "a/y/d.ts"]);
  });

  test("lists full paths flat in the exact diff order", () => {
    const rows = fileRows(["z.ts", "src/b.ts", "docs/x.md", "src/a.ts"].map(file), ["old.ts"], "list");
    expect(outline(rows)).toEqual(["z.ts", "src/b.ts", "docs/x.md", "src/a.ts", "old.ts"]);
    expect(rows.at(-1)?.type).toBe("missing");
  });
});
