import { describe, expect, it } from "bun:test";
import { groupTitle, groupTitles } from "./group-title.ts";

describe("groupTitle", () => {
  it("names a single file with its directory, folding in its test", () => {
    expect(groupTitle(["src/review/core/runner.ts", "src/review/core/runner.test.ts"])).toBe("core/runner");
    expect(groupTitle(["src/cli/doctor.ts"])).toBe("cli/doctor");
    expect(groupTitle(["index.ts"])).toBe("index");
  });

  it("lists two files when they fit", () => {
    expect(groupTitle(["src/review/models.ts", "src/review/model-catalog.ts"])).toBe("models, model-catalog");
    expect(groupTitle(["src/web/lib/a.ts", "src/web/components/B.tsx"])).toBe("a, B");
  });

  it("leads with the most changed file past two names or when two do not fit", () => {
    const lines: Record<string, number> = { "src/a.ts": 5, "src/b.ts": 40, "src/c.ts": 10 };
    expect(groupTitle(Object.keys(lines), (f) => lines[f] ?? 0)).toBe("b +2");
    expect(groupTitle(["package.json", "tsconfig.json"])).toBe("package.json +1");
  });

  it("counts a test's lines toward the file it tests", () => {
    const lines: Record<string, number> = { "src/a.ts": 10, "src/b.ts": 8, "src/b.test.ts": 8 };
    expect(groupTitle(Object.keys(lines), (f) => lines[f] ?? 0)).toBe("b, a");
  });

  it("keeps the parent directory of generic names", () => {
    expect(groupTitle(["src/cli/index.ts", "src/cli/runs.ts"], (f) => (f.endsWith("index.ts") ? 9 : 1))).toBe(
      "cli/index, runs",
    );
    expect(groupTitle(["src/types.d.ts"])).toBe("src/types");
  });

  it("keeps the extension of non-code files", () => {
    expect(groupTitle(["README.md"])).toBe("README.md");
    expect(groupTitle(["docs/images/a.png", "docs/images/b.png"])).toBe("a.png, b.png");
  });

  it("handles an empty group", () => {
    expect(groupTitle([])).toBe("Files");
  });
});

describe("groupTitles", () => {
  it("adds the directory to titles that would repeat, then numbers them", () => {
    expect(
      groupTitles([
        { files: ["src/cli/config.ts"] },
        { files: ["src/services/config.ts"] },
        { files: ["src/a/x.ts", "src/a/y.ts", "src/a/z.ts"] },
        { files: ["src/a/x.ts", "src/a/q.ts", "src/a/r.ts"] },
        { files: ["src/w.ts"] },
      ]),
    ).toEqual(["cli/config", "services/config", "a/x +2", "a/x +2 (2)", "src/w"]);
  });
});
