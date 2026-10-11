import { describe, expect, it } from "bun:test";
import { groupTitle, groupTitles } from "./group-title.ts";

describe("groupTitle", () => {
  it("folds a test into the file it tests", () => {
    expect(groupTitle(["src/review/core/runner.ts", "src/review/core/runner.test.ts"])).toBe("src/review/core: runner");
  });

  it("lists up to three names after the common directory", () => {
    expect(groupTitle(["src/review/core/pipeline.ts", "src/review/core/runner.ts"])).toBe(
      "src/review/core: pipeline, runner",
    );
    expect(groupTitle(["src/web/lib/a.ts", "src/web/components/B.tsx"])).toBe("src/web: lib/a, components/B");
  });

  it("uses the directory alone past three names", () => {
    const files = ["a", "b", "c", "d", "e", "f"].map((n) => `src/web/${n}.ts`);
    expect(groupTitle(files)).toBe("src/web");
  });

  it("names the subdirectories under the common directory past three names", () => {
    const files = ["src/cli/a.ts", "src/cli/b.ts", "src/review/c.ts", "src/server/d.ts", "src/types/e.ts"];
    expect(groupTitle(files)).toBe("src: cli, review, server, types");
    expect(groupTitle([...files, "src/web/f.ts"])).toBe("src");
    expect(groupTitle(["src/a.ts", "src/b.ts", "src/c.ts", "src/lib/d.ts"])).toBe("src: a, b, c, lib");
  });

  it("handles top-level files", () => {
    expect(groupTitle(["index.ts"])).toBe("index");
    expect(groupTitle(["a.ts", "b.ts", "c.ts", "d.ts"])).toBe("Top-level files");
    expect(groupTitle(["types.d.ts", "src/x.ts"])).toBe("types, src/x");
  });

  it("numbers repeated titles", () => {
    const six = (d: string) => ["a", "b", "c", "d"].map((n) => `${d}/${n}.ts`);
    expect(groupTitles([{ files: six("src") }, { files: six("src") }, { files: ["src/x.ts"] }])).toEqual([
      "src",
      "src (2)",
      "src: x",
    ]);
  });
});
